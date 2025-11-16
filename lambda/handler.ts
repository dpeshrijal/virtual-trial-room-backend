// virtual_trial_room_backend/lambda/handler.ts

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "crypto";

// --- Client Initialization (outside handler for performance) ---
const ssmClient = new SSMClient({});
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});

// --- Environment Variables ---
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET_NAME!;
const GEMINI_API_KEY_PARAM_NAME = process.env.GEMINI_API_KEY_PARAM_NAME!;
const JOBS_TABLE = process.env.JOBS_TABLE_NAME!;

// --- Caching for API Key and Model ---
let geminiApiKey: string | undefined;
let genAI: GoogleGenerativeAI | undefined;

// --- Helper Functions ---

// Fetches the API key from Parameter Store, caching it for subsequent invocations
async function getGeminiApiKey(): Promise<string> {
  if (geminiApiKey) {
    return geminiApiKey;
  }
  console.log("Fetching Gemini API key from Parameter Store...");
  const command = new GetParameterCommand({
    Name: GEMINI_API_KEY_PARAM_NAME,
    WithDecryption: true,
  });
  const response = await ssmClient.send(command);
  const key = response.Parameter?.Value;
  if (!key) {
    throw new Error("Failed to retrieve Gemini API key from Parameter Store.");
  }
  geminiApiKey = key;
  return geminiApiKey;
}

// Downloads an image from a presigned S3 URL and returns its buffer and mime type
async function urlToGenerativePart(
  url: string,
  mimeType: string = "image/jpeg"
): Promise<{ inlineData: { data: string; mimeType: string } }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from URL: ${url}`);
  }
  const buffer = await response.arrayBuffer();
  return {
    inlineData: {
      data: Buffer.from(buffer).toString("base64"),
      mimeType,
    },
  };
}

// --- Async Job Processing ---
async function processJobAsync(jobId: string): Promise<void> {
  try {
    // Get job details from DynamoDB
    const getResult = await dynamoClient.send(
      new GetItemCommand({
        TableName: JOBS_TABLE,
        Key: marshall({ jobId }),
      })
    );

    if (!getResult.Item) {
      throw new Error("Job not found");
    }

    const job = unmarshall(getResult.Item);
    const userImageKey = job.userImageKey;
    const outfitImageKey = job.outfitImageKey;
    const garmentType = job.garmentType || "auto";

    // Update progress: 10%
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: JOBS_TABLE,
        Key: marshall({ jobId }),
        UpdateExpression: "SET progress = :progress",
        ExpressionAttributeValues: marshall({ ":progress": 10 }),
      })
    );

    // Get presigned URLs for images from S3
    const userImageSignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: userImageKey }),
      { expiresIn: 300 }
    );
    const outfitImageSignedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: outfitImageKey }),
      { expiresIn: 300 }
    );

    // Fetch and prepare image parts
    const userImagePart = await urlToGenerativePart(
      userImageSignedUrl,
      job.userImageMimeType || "image/jpeg"
    );
    const outfitImagePart = await urlToGenerativePart(
      outfitImageSignedUrl,
      job.outfitImageMimeType || "image/jpeg"
    );

    // Update progress: 30%
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: JOBS_TABLE,
        Key: marshall({ jobId }),
        UpdateExpression: "SET progress = :progress",
        ExpressionAttributeValues: marshall({ ":progress": 30 }),
      })
    );

    // Initialize Gemini AI
    if (!genAI) {
      const apiKey = await getGeminiApiKey();
      genAI = new GoogleGenerativeAI(apiKey);
    }
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });

    // Update progress: 40%
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: JOBS_TABLE,
        Key: marshall({ jobId }),
        UpdateExpression: "SET progress = :progress",
        ExpressionAttributeValues: marshall({ ":progress": 40 }),
      })
    );

    // Build prompt based on garment type
    let garmentTypeInstruction = "";
    if (garmentType !== "auto") {
      garmentTypeInstruction = `\nGARMENT TYPE: This is a ${garmentType}. ONLY replace the ${garmentType} - do NOT change any other clothing items.\n`;
    }

    const prompt = `🚨 CRITICAL: Output image MUST be EXACT same dimensions as input person photo. Do NOT change aspect ratio or canvas size under any circumstances.

Person photo: [first image]
Garment to try on: [second image]
${garmentTypeInstruction}

🎯 YOUR TASK - COMPLETE GARMENT REPLACEMENT:
STEP 1: IDENTIFY the type of garment in the second image (shirt, t-shirt, jacket, dress, pants, etc.)
STEP 2: COMPLETELY REMOVE the corresponding clothing item from the person in the first image
STEP 3: REPLACE it with the new garment from the second image

⚠️ CRITICAL UNDERSTANDING - THIS IS NOT LAYERING:
❌ DO NOT place the new garment ON TOP of existing clothing
❌ DO NOT keep any part of the old clothing visible underneath
✅ COMPLETELY REMOVE the old garment and REPLACE with the new one
✅ The new garment should be worn directly on the person's body (or over undergarments if appropriate)

EXAMPLE - If replacing a t-shirt:
❌ WRONG: Person wearing original shirt + new t-shirt layered on top
✅ CORRECT: Original shirt GONE, person wearing ONLY the new t-shirt

⚠️ STRICT PRESERVATION RULES - DO NOT VIOLATE:

1. PRESERVE ORIGINAL IMAGE DIMENSIONS (MOST IMPORTANT):
   - Output MUST be same width and height as person photo
   - Do NOT expand, crop, or resize the canvas
   - Do NOT add background areas
   - Do NOT extend the image borders
   - Keep exact same framing and composition

2. PRESERVE PERSON'S FACE & BODY:
   - Face MUST remain 100% identical - same skin tone, features, expression
   - Do NOT apply any AI effects, smoothing, or beautification to face
   - Do NOT change skin color, texture, or lighting on face
   - Do NOT modify hair, eyes, nose, mouth, or any facial features
   - Body proportions MUST stay exactly the same
   - Do NOT change pose, posture, or body position
   - Skin/arms/neck visible in original MUST stay exactly the same

3. PRESERVE BACKGROUND:
   - Background MUST remain pixel-perfect identical
   - Do NOT blur, sharpen, or modify background in ANY way
   - Do NOT add or remove background elements
   - Do NOT change background colors or lighting
   - Keep all background objects, walls, furniture exactly as-is

4. PRESERVE OTHER CLOTHING ITEMS:
   ${garmentType === "top" ? "- Do NOT change pants, skirts, shorts, or any bottom wear\n   - Do NOT change shoes, accessories, or jewelry" : ""}
   ${garmentType === "bottom" ? "- Do NOT change shirts, tops, jackets, or any upper wear\n   - Do NOT change shoes, accessories, or jewelry" : ""}
   ${garmentType === "dress" || garmentType === "full outfit" ? "- Do NOT change shoes or accessories unless shown in garment image" : ""}
   - If person wears jewelry, glasses, watch, etc. → keep them EXACTLY as-is
   - Do NOT remove or add clothing items not in the garment image

5. COMPLETE REPLACEMENT RULES (MOST CRITICAL):
   - STEP 1: Remove the old garment ENTIRELY - it should NOT be visible at all
   - STEP 2: Place the new garment directly on the person's body
   - STEP 3: Ensure NO layering - the new garment replaces, not covers
   - The new garment should fit the person's body exactly as shown in garment image
   - Match the wearing style from garment image (buttoned/unbuttoned, tucked/untucked, etc.)
   - Keep same color, pattern, and style as shown in garment image
   - Do NOT show any trace of the original clothing underneath

6. LIGHTING & QUALITY:
   - Match lighting of original person photo
   - Keep same photo quality and grain
   - Do NOT over-smooth or make image look overly AI-generated
   - Maintain realistic, natural photographic quality

❌ ABSOLUTELY FORBIDDEN:
- Layering new garment over old clothing (CRITICAL ERROR)
- Keeping any part of old garment visible
- Expanding image canvas or adding background
- Changing facial features or applying beauty filters
- Modifying background in any way
- Changing clothing items other than the specified garment
- Altering image dimensions
- Adding AI-generated artifacts
- Making the output image square or any different aspect ratio than the input

✅ YOUR ONLY JOB:
COMPLETELY REMOVE the target garment from the person and REPLACE it with the new garment. The old clothing MUST be gone - not hidden underneath, but REMOVED. Everything else (face, body, pose, background, other clothes) stays 100% identical.

🔒 FINAL REMINDER:
1. The output image dimensions and aspect ratio MUST exactly match the input person photo
2. The old garment MUST be COMPLETELY REMOVED before adding the new one
3. NO layering - this is a REPLACEMENT, not an overlay

Generate result now - complete replacement, preserve everything else.`;

    console.log(`Processing job ${jobId} with Gemini API...`);

    // Start simulated progress updates during AI processing
    const progressInterval = setInterval(async () => {
      try {
        // Get current progress
        const currentJob = await dynamoClient.send(
          new GetItemCommand({
            TableName: JOBS_TABLE,
            Key: marshall({ jobId }),
          })
        );

        if (currentJob.Item) {
          const job = unmarshall(currentJob.Item);
          const currentProgress = job.progress || 40;

          // Increment progress gradually from 40% to 75% (leave room for completion)
          if (currentProgress < 75) {
            const newProgress = Math.min(currentProgress + 5, 75);
            await dynamoClient.send(
              new UpdateItemCommand({
                TableName: JOBS_TABLE,
                Key: marshall({ jobId }),
                UpdateExpression: "SET progress = :progress",
                ExpressionAttributeValues: marshall({ ":progress": newProgress }),
              })
            );
          }
        }
      } catch (err) {
        console.error("Error updating progress:", err);
      }
    }, 2000); // Update every 2 seconds

    try {
      const result = await model.generateContent([
        prompt,
        userImagePart,
        outfitImagePart,
      ]);
      const response = result.response;

      // Clear the interval once AI processing is done
      clearInterval(progressInterval);

      // Update progress: 85%
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: JOBS_TABLE,
          Key: marshall({ jobId }),
          UpdateExpression: "SET progress = :progress",
          ExpressionAttributeValues: marshall({ ":progress": 85 }),
        })
      );

      const firstPart = response.candidates?.[0]?.content?.parts?.[0];
      if (!firstPart || !("inlineData" in firstPart) || !firstPart.inlineData?.data) {
        throw new Error("Failed to generate result. Please try again with different images.");
      }

      const generatedImageBase64 = firstPart.inlineData.data;
      const imageBuffer = Buffer.from(generatedImageBase64, "base64");
      const resultKey = `result-${randomUUID()}.jpeg`;

      // Update progress: 90%
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: JOBS_TABLE,
          Key: marshall({ jobId }),
          UpdateExpression: "SET progress = :progress",
          ExpressionAttributeValues: marshall({ ":progress": 90 }),
        })
      );

      // Upload result to S3
      await s3Client.send(
        new PutObjectCommand({
          Bucket: RESULTS_BUCKET,
          Key: resultKey,
          Body: imageBuffer,
          ContentType: "image/jpeg",
        })
      );

      // Generate presigned URL
      const resultSignedUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: resultKey }),
        { expiresIn: 3600 }
      );

      // Update job as completed
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: JOBS_TABLE,
          Key: marshall({ jobId }),
          UpdateExpression: "SET #status = :status, imageUrl = :imageUrl, progress = :progress",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":status": "completed",
            ":imageUrl": resultSignedUrl,
            ":progress": 100,
          }),
        })
      );

      console.log(`Job ${jobId} completed successfully`);
    } catch (error: any) {
      // Clear interval on error
      clearInterval(progressInterval);
      throw error; // Re-throw to be caught by outer error handler
    }
  } catch (error: any) {
    console.error(`Error processing job ${jobId}:`, error);
    throw error; // Re-throw to be caught by the error handler in the main handler
  }
}

// --- Main Lambda Handler ---
export const handler = async (
  event: APIGatewayProxyEvent | { jobId: string }
): Promise<APIGatewayProxyResult | void> => {
  console.log("Event received:", JSON.stringify(event, null, 2));

  // Check if this is a background processing invocation
  if ("jobId" in event && !("httpMethod" in event)) {
    // This is a background job processing invocation
    const jobId = event.jobId;
    console.log(`Background processing for job ${jobId}`);
    try {
      await processJobAsync(jobId);
      console.log(`Job ${jobId} processed successfully`);
    } catch (error: any) {
      console.error(`Error processing job ${jobId}:`, error);
      // Update job status to failed
      try {
        await dynamoClient.send(
          new UpdateItemCommand({
            TableName: JOBS_TABLE,
            Key: marshall({ jobId }),
            UpdateExpression: "SET #status = :status, #error = :error",
            ExpressionAttributeNames: {
              "#status": "status",
              "#error": "error",
            },
            ExpressionAttributeValues: marshall({
              ":status": "failed",
              ":error": error.message || "Unknown error",
            }),
          })
        );
      } catch (updateError: any) {
        console.error(`Error updating job ${jobId} status:`, updateError);
      }
    }
    return; // No response needed for background processing
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // Type guard for API Gateway events
  const apiEvent = event as APIGatewayProxyEvent;

  try {
    // Handle GET requests for job status
    if (apiEvent.httpMethod === "GET") {
      const jobId = apiEvent.queryStringParameters?.jobId;
      if (!jobId) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Missing jobId parameter" }),
        };
      }

      // Fetch job status from DynamoDB
      const getResult = await dynamoClient.send(
        new GetItemCommand({
          TableName: JOBS_TABLE,
          Key: marshall({ jobId }),
        })
      );

      if (!getResult.Item) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Job not found" }),
        };
      }

      const job = unmarshall(getResult.Item);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          jobId: job.jobId,
          status: job.status,
          imageUrl: job.imageUrl,
          error: job.error,
          progress: job.progress || 0,
        }),
      };
    }

    // Handle POST requests for job submission
    if (apiEvent.httpMethod === "POST") {
      if (!apiEvent.body) {
        throw new Error("Missing request body");
      }

      // 1. Parse the incoming request body
      const body = JSON.parse(apiEvent.body);

      // Check if async mode is requested
      if (body.async === true) {
        const jobId = randomUUID();
        const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now

        // Save images to S3 first (DynamoDB has 400KB item limit)
        const userKey = `user-images/${jobId}.jpeg`;
        const outfitKey = `outfit-images/${jobId}.jpeg`;

        await Promise.all([
          s3Client.send(
            new PutObjectCommand({
              Bucket: UPLOADS_BUCKET,
              Key: userKey,
              Body: Buffer.from(body.userImageBase64, "base64"),
              ContentType: body.userImageMimeType || "image/jpeg",
            })
          ),
          s3Client.send(
            new PutObjectCommand({
              Bucket: UPLOADS_BUCKET,
              Key: outfitKey,
              Body: Buffer.from(body.outfitImageBase64, "base64"),
              ContentType: body.outfitImageMimeType || "image/jpeg",
            })
          ),
        ]);

        // Create job record in DynamoDB (without images to avoid 400KB limit)
        await dynamoClient.send(
          new PutItemCommand({
            TableName: JOBS_TABLE,
            Item: marshall({
              jobId,
              status: "processing",
              progress: 0,
              createdAt: new Date().toISOString(),
              ttl,
              userImageKey: userKey,
              outfitImageKey: outfitKey,
              userImageMimeType: body.userImageMimeType || "image/jpeg",
              outfitImageMimeType: body.outfitImageMimeType || "image/jpeg",
              garmentType: body.garmentType || "auto",
            }),
          })
        );

        // Invoke Lambda asynchronously to process the job in the background
        const lambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME!;
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: lambdaFunctionName,
            InvocationType: "Event", // Async invocation
            Payload: JSON.stringify({ jobId }),
          })
        );

        console.log(`Async Lambda invocation triggered for job ${jobId}`);

        // Return immediately with jobId
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            jobId,
            status: "processing",
            message: "Job submitted successfully",
          }),
        };
      }

      // Sync mode (original behavior)
      // Support both methods: base64 images or S3 keys
      let userImagePart: { inlineData: { data: string; mimeType: string } };
      let outfitImagePart: { inlineData: { data: string; mimeType: string } };

      if (body.userImageBase64 && body.outfitImageBase64) {
        // Method 1: Direct base64 upload (simpler, no S3 needed for inputs)
        userImagePart = {
          inlineData: {
            data: body.userImageBase64,
            mimeType: body.userImageMimeType || "image/jpeg",
          },
        };
        outfitImagePart = {
          inlineData: {
            data: body.outfitImageBase64,
            mimeType: body.outfitImageMimeType || "image/jpeg",
          },
        };

        // Optionally save to S3 for record keeping
        if (body.saveToS3) {
          const userKey = `user-images/${randomUUID()}.jpeg`;
          const outfitKey = `outfit-images/${randomUUID()}.jpeg`;

          await Promise.all([
            s3Client.send(
              new PutObjectCommand({
                Bucket: UPLOADS_BUCKET,
                Key: userKey,
                Body: Buffer.from(body.userImageBase64, "base64"),
                ContentType: body.userImageMimeType || "image/jpeg",
              })
            ),
            s3Client.send(
              new PutObjectCommand({
                Bucket: UPLOADS_BUCKET,
                Key: outfitKey,
                Body: Buffer.from(body.outfitImageBase64, "base64"),
                ContentType: body.outfitImageMimeType || "image/jpeg",
              })
            ),
          ]);
        }
      } else if (body.userImageKey && body.outfitImageKey) {
        // Method 2: S3 keys (original method)
        const userImageSignedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: body.userImageKey }),
          { expiresIn: 300 }
        );
        const outfitImageSignedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: body.outfitImageKey }),
          { expiresIn: 300 }
        );

        userImagePart = await urlToGenerativePart(userImageSignedUrl);
        outfitImagePart = await urlToGenerativePart(outfitImageSignedUrl);
      } else {
        throw new Error(
          "Either provide userImageBase64 & outfitImageBase64, or userImageKey & outfitImageKey"
        );
      }

      // 2. Initialize the Gemini SDK (cached)
      if (!genAI) {
        const apiKey = await getGeminiApiKey();
        genAI = new GoogleGenerativeAI(apiKey);
      }

      // Using gemini-2.5-flash-image model
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });

      // 3. Prepare the prompt for the model
      const prompt = `Person image: [first image]
New garment image: [second image]

TASK OVERVIEW:
Replace ALL of the person's current clothing with the new garment shown in the garment image. This is a complete clothing change, not an addition or layer.

STEP 1 - UNDERSTAND CURRENT STATE:
Analyze what clothing the person is currently wearing (shirt, jacket, blazer, t-shirt, dress, etc.)
Note: This existing clothing will be COMPLETELY REMOVED and REPLACED

STEP 2 - UNDERSTAND NEW GARMENT:
Analyze the new garment image
Identify: garment type, color, pattern, how it's worn, all details
Note: This will be the ONLY clothing visible in the final result

STEP 3 - PERFORM COMPLETE REPLACEMENT:
Remove ALL existing clothing from the person's body
Replace with ONLY the new garment
Do NOT keep any elements from the old outfit
Do NOT layer the new garment over existing clothes
Do NOT combine old and new clothing
The new garment is the complete outfit - nothing else

STEP 4 - WEAR NEW GARMENT AS SHOWN:
Wear the new garment EXACTLY as shown in the garment image
If garment image shows it buttoned → wear it buttoned
If garment image shows it open → wear it open
If garment image shows it tucked → wear it tucked
If garment image shows it loose → wear it loose
Copy the exact wearing style from the garment image
Do NOT copy the wearing style from the person's current outfit
Ignore how the person's current clothes are worn

CRITICAL RULES:
❌ Do NOT keep the person's current clothing
❌ Do NOT layer new garment over old clothes
❌ Do NOT mimic styling from current outfit
❌ Do NOT add pieces not shown in garment image
❌ Do NOT interpret or modify the new garment
✅ DO completely replace all clothing
✅ DO show ONLY the new garment
✅ DO wear it exactly as shown in garment image
✅ DO preserve person's face, body, pose, background
✅ DO make it look photorealistic

REMEMBER: This is a complete wardrobe change. Old outfit is completely gone. New garment is all that's visible. Wear it as demonstrated in garment image, not as the old outfit was worn.

Generate photorealistic result now.`;

      // 5. Call the Gemini API via the SDK
      console.log("Calling Gemini API via SDK...");
      const result = await model.generateContent([
        prompt,
        userImagePart,
        outfitImagePart,
      ]);
      const response = result.response;

      const firstPart = response.candidates?.[0]?.content?.parts?.[0];

      if (firstPart && "inlineData" in firstPart && firstPart.inlineData?.data) {
        // The optional chaining (?.) and the check above ensure inlineData and its data property exist.
        const generatedImageBase64 = firstPart.inlineData.data;

        // 6. Decode the Base64 response and save it to the results S3 bucket
        const imageBuffer = Buffer.from(generatedImageBase64, "base64");
        const resultKey = `result-${randomUUID()}.jpeg`;

        await s3Client.send(
          new PutObjectCommand({
            Bucket: RESULTS_BUCKET,
            Key: resultKey,
            Body: imageBuffer,
            ContentType: "image/jpeg",
          })
        );
        console.log(
          `Successfully uploaded result image to s3://${RESULTS_BUCKET}/${resultKey}`
        );

        // 7. Generate a presigned URL for the final image to send back to the frontend
        const resultSignedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: resultKey }),
          { expiresIn: 3600 }
        );

        // 8. Return the successful response
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Image processed successfully!",
            imageUrl: resultSignedUrl,
          }),
        };
      } else {
        console.error(
          "Gemini response did not contain image data. Full response:",
          JSON.stringify(response, null, 2)
        );
        throw new Error("Failed to generate result. Please try again with different images.");
      }
    }

    // Handle unsupported methods
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (error: any) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Failed to process image.",
        error: error.message || "An unknown error occurred.",
      }),
    };
  }
};
