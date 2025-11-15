// virtual_trial_room_backend/lib/backend-stack.ts

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";

export class VirtualTrialRoomBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3 Buckets ---

    // 1. Bucket for user uploads (source images)
    const uploadsBucket = new s3.Bucket(this, "VirtualTryonUploadsBucket", {
      // Enable CORS to allow our frontend to read images if needed
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.POST,
            s3.HttpMethods.PUT,
          ],
          allowedOrigins: ["*"], // In production, restrict this to your domain!
          allowedHeaders: ["*"],
        },
      ],
      // Automatically delete objects when the bucket is deleted (for dev)
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2. Bucket for processed results (final images)
    const resultsBucket = new s3.Bucket(this, "VirtualTryonResultsBucket", {
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ["*"], // In production, restrict this to your domain!
          allowedHeaders: ["*"],
        },
      ],
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- IAM Permissions ---

    // 3. IAM Policy to allow reading the Gemini API key from Parameter Store
    const geminiApiKeyPolicy = new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/virtual-tryon/gemini-api-key`,
      ],
    });

    // --- Lambda Function ---

    // 4. The main Lambda function to process images
    const apiLambda = new NodejsFunction(this, "ApiHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      // We will create this file in the next step
      entry: path.join(__dirname, "../lambda/handler.ts"),
      handler: "handler",
      // Pass necessary info to the Lambda as environment variables
      environment: {
        UPLOADS_BUCKET_NAME: uploadsBucket.bucketName,
        RESULTS_BUCKET_NAME: resultsBucket.bucketName,
        GEMINI_API_KEY_PARAM_NAME: "/virtual-tryon/gemini-api-key",
      },
      timeout: cdk.Duration.seconds(30), // Increase timeout for AI processing
    });

    // 5. Attach the policy to the Lambda's execution role
    apiLambda.addToRolePolicy(geminiApiKeyPolicy);

    // 6. Grant the Lambda permissions to read/write to our S3 buckets
    uploadsBucket.grantReadWrite(apiLambda); // Changed from grantRead to grantReadWrite for saveToS3 functionality
    resultsBucket.grantReadWrite(apiLambda);

    // --- API Gateway ---

    // 7. API Gateway to create a public endpoint for our Lambda
    const api = new apigateway.LambdaRestApi(this, "VirtualTryonApi", {
      handler: apiLambda,
      proxy: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // In production, restrict this!
        allowMethods: apigateway.Cors.ALL_METHODS, // Allows GET, POST, etc.
        allowHeaders: [
          "Content-Type",
          "X-Amz-Date",
          "Authorization",
          "X-Api-Key",
        ],
      },
    });

    // --- Outputs ---

    // 8. Print out important values after deployment
    new cdk.CfnOutput(this, "UploadsBucketName", {
      value: uploadsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "ResultsBucketName", {
      value: resultsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "ApiEndpointUrl", {
      value: api.url,
    });
  }
}
