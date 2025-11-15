// virtual_trial_room_backend/lambda/handler.ts

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "crypto";

// --- Client Initialization (outside handler for performance) ---
const ssmClient = new SSMClient({});
const s3Client = new S3Client({});

// --- Environment Variables ---
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET_NAME!;
const GEMINI_API_KEY_PARAM_NAME = process.env.GEMINI_API_KEY_PARAM_NAME!;

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

// --- Main Lambda Handler ---
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Event received:", JSON.stringify(event, null, 2));

  try {
    if (!event.body) {
      throw new Error("Missing request body");
    }

    // 1. Parse the incoming request body
    const body = JSON.parse(event.body);

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
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
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
      throw new Error("No image data found in Gemini response.");
    }
  } catch (error: any) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        message: "Failed to process image.",
        error: error.message || "An unknown error occurred.",
      }),
    };
  }
};
