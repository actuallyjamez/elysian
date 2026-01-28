/**
 * Init command - Initialize a new elysian project
 */

import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

export const initCommand = defineCommand({
	meta: {
		name: "init",
		description: "Initialize a new elysian project",
	},
	args: {
		name: {
			type: "string",
			description: "API name",
			default: "my-api",
		},
		force: {
			type: "boolean",
			description: "Overwrite existing files",
			default: false,
		},
	},
	async run({ args }) {
		const cwd = process.cwd();
		const apiName = args.name;

		consola.start(`Initializing elysian project: ${apiName}`);

		// Check for existing config
		const configPath = join(cwd, "elysian.config.ts");
		if (existsSync(configPath) && !args.force) {
			consola.error(
				"elysian.config.ts already exists. Use --force to overwrite.",
			);
			process.exit(1);
		}

		// Create directories
		const lambdasDir = join(cwd, "src/lambdas");
		const terraformDir = join(cwd, "terraform");

		mkdirSync(lambdasDir, { recursive: true });
		mkdirSync(terraformDir, { recursive: true });

		consola.success("Created src/lambdas/");
		consola.success("Created terraform/");

		// Write config file
		const configContent = `import { defineConfig } from "@actuallyjamez/elysian";

export default defineConfig({
	apiName: "${apiName}",

	// Lambda source directory
	lambdasDir: "src/lambdas",

	// Build output directory
	outputDir: "dist",

	// OpenAPI configuration
	openapi: {
		enabled: true,
		title: "${apiName}",
		version: "1.0.0",
		description: "API powered by Elysia and AWS Lambda",
	},

	// Terraform configuration
	terraform: {
		outputDir: "terraform",
		tfvarsFilename: "api-routes.auto.tfvars",
	},

	// Lambda defaults
	lambda: {
		runtime: "nodejs20.x",
		memorySize: 256,
		timeout: 30,
	},
});
`;

		await Bun.write(configPath, configContent);
		consola.success("Created elysian.config.ts");

		// Write example lambda
		const exampleLambdaPath = join(lambdasDir, "hello.ts");
		if (!existsSync(exampleLambdaPath) || args.force) {
			const exampleLambdaContent = `import { createLambda, t } from "@actuallyjamez/elysian";

/**
 * Example Lambda - Hello World
 *
 * Routes defined here will be automatically:
 * - Bundled into a Lambda function
 * - Mapped to API Gateway routes
 * - Included in OpenAPI documentation
 */
export default createLambda()
	.get("/hello", ({ query }) => {
		return \`Hello, \${query.name ?? "World"}!\`;
	}, {
		response: t.String(),
		query: t.Object({
			name: t.Optional(t.String()),
		}),
		detail: {
			summary: "Say hello",
			description: "Returns a greeting message",
			tags: ["Greeting"],
		},
	});
`;

			await Bun.write(exampleLambdaPath, exampleLambdaContent);
			consola.success("Created src/lambdas/hello.ts");
		}

		// Write Terraform main.tf template
		const terraformMainPath = join(terraformDir, "main.tf");
		if (!existsSync(terraformMainPath) || args.force) {
			const terraformContent = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "lambda_names" {
  type    = list(string)
  default = []
}

variable "api_routes" {
  type = map(object({
    lambda_key      = string
    route_key       = string
    path_parameters = list(string)
  }))
  default = {}
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs20.x"
}

variable "lambda_memory_size" {
  type    = number
  default = 256
}

variable "lambda_timeout" {
  type    = number
  default = 30
}

variable "api_name" {
  type    = string
  default = "${apiName}"
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  lambda_functions = {
    for name in var.lambda_names : name => {
      filename         = "\${path.module}/../dist/\${name}.zip"
      handler          = "index.handler"
      source_code_hash = filebase64sha256("\${path.module}/../dist/\${name}.zip")
    }
  }
}

# API Gateway
resource "aws_apigatewayv2_api" "this" {
  name          = var.api_name
  protocol_type = "HTTP"
  description   = "API Gateway for \${var.api_name}"
  tags          = var.tags
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda" {
  name = "\${var.api_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda Functions
resource "aws_lambda_function" "this" {
  for_each = local.lambda_functions

  filename         = each.value.filename
  function_name    = "\${var.api_name}-\${each.key}"
  role             = aws_iam_role.lambda.arn
  handler          = each.value.handler
  source_code_hash = each.value.source_code_hash
  runtime          = var.lambda_runtime
  memory_size      = var.lambda_memory_size
  timeout          = var.lambda_timeout

  tags = var.tags
}

# API Gateway Integrations
resource "aws_apigatewayv2_integration" "this" {
  for_each = local.lambda_functions

  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.this[each.key].invoke_arn
  integration_method = "POST"
  payload_format_version = "2.0"
}

# Lambda Permissions
resource "aws_lambda_permission" "apigateway" {
  for_each = local.lambda_functions

  statement_id  = "AllowExecutionFromAPIGateway-\${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "\${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# API Gateway Routes
resource "aws_apigatewayv2_route" "this" {
  for_each = var.api_routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.route_key
  target    = "integrations/\${aws_apigatewayv2_integration.this[each.value.lambda_key].id}"
}

# API Gateway Stage
resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  tags = var.tags

  depends_on = [
    aws_apigatewayv2_route.this,
    aws_lambda_permission.apigateway
  ]
}

# Outputs
output "api_endpoint" {
  value = aws_apigatewayv2_stage.this.invoke_url
}

output "lambda_functions" {
  value = { for k, v in aws_lambda_function.this : k => v.arn }
}
`;

			await Bun.write(terraformMainPath, terraformContent);
			consola.success("Created terraform/main.tf");
		}

		// Print next steps
		console.log("");
		consola.box(
			"Project initialized!\n\n" +
				"Next steps:\n\n" +
				"1. Install dependencies:\n" +
				"   bun add elysia @actuallyjamez/elysian\n\n" +
				"2. Add more lambdas in src/lambdas/\n\n" +
				"3. Build your lambdas:\n" +
				"   bunx elysian build\n\n" +
				"4. Deploy with Terraform:\n" +
				"   cd terraform && terraform init && terraform apply",
		);
	},
});
