/**
 * Smart Terraform file handling - append missing blocks
 */

/**
 * Check if content has AWS provider configured
 */
export function hasAwsProvider(content: string): boolean {
	return /source\s*=\s*["']hashicorp\/aws["']/.test(content);
}

/**
 * Check if a variable exists in the content
 */
export function hasVariable(content: string, name: string): boolean {
	const regex = new RegExp(`variable\\s+["']${name}["']`, "i");
	return regex.test(content);
}

/**
 * Check if a resource of a given type exists
 */
export function hasResource(content: string, type: string): boolean {
	const regex = new RegExp(`resource\\s+["']${type}["']`, "i");
	return regex.test(content);
}

/**
 * Check if an output exists in the content
 */
export function hasOutput(content: string, name: string): boolean {
	const regex = new RegExp(`output\\s+["']${name}["']`, "i");
	return regex.test(content);
}

/**
 * Providers template
 */
const PROVIDERS_BLOCK = `
# Elysian: AWS Provider Configuration
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
}
`;

/**
 * Smart append to providers.tf - only add if AWS provider is missing
 */
export function appendProviders(existing: string): string {
	if (hasAwsProvider(existing)) {
		return existing; // Already has AWS provider
	}
	return existing + "\n" + PROVIDERS_BLOCK;
}

/**
 * Get missing variables and return the block to append
 */
export function getMissingVariables(existing: string, name: string): string {
	const variables: Record<string, string> = {
		region: `
variable "region" {
  type    = string
  default = "eu-west-2"
}`,
		lambda_names: `
variable "lambda_names" {
  type    = list(string)
  default = []
}`,
		api_routes: `
variable "api_routes" {
  type = map(object({
    lambda_key      = string
    route_key       = string
    path_parameters = list(string)
  }))
  default = {}
}`,
		lambda_runtime: `
variable "lambda_runtime" {
  type    = string
  default = "nodejs22.x"
}`,
		lambda_memory_size: `
variable "lambda_memory_size" {
  type    = number
  default = 256
}`,
		lambda_timeout: `
variable "lambda_timeout" {
  type    = number
  default = 30
}`,
		api_name: `
	variable "api_name" {
  type    = string
  default = "${name}"
}`,
		tags: `
variable "tags" {
  type    = map(string)
  default = {}
}`,
	};

	const missing: string[] = [];
	for (const [name, block] of Object.entries(variables)) {
		if (!hasVariable(existing, name)) {
			missing.push(block);
		}
	}

	if (missing.length === 0) {
		return existing;
	}

	return existing + "\n# Elysian: Required Variables" + missing.join("");
}

/**
 * Main resources template
 */
const MAIN_RESOURCES = `
# Elysian: Lambda and API Gateway Resources

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
resource "aws_apigatewayv2_api" "elysian" {
  name          = var.api_name
  protocol_type = "HTTP"
  tags          = var.tags
}

# IAM Role for Lambda
resource "aws_iam_role" "elysian_lambda" {
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

resource "aws_iam_role_policy_attachment" "elysian_lambda_basic" {
  role       = aws_iam_role.elysian_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda Functions
resource "aws_lambda_function" "elysian" {
  for_each = local.lambda_functions

  filename         = each.value.filename
  function_name    = each.key
  role             = aws_iam_role.elysian_lambda.arn
  handler          = each.value.handler
  source_code_hash = each.value.source_code_hash
  runtime          = var.lambda_runtime
  memory_size      = var.lambda_memory_size
  timeout          = var.lambda_timeout

  tags = var.tags
}

# API Gateway Integrations
resource "aws_apigatewayv2_integration" "elysian" {
  for_each = local.lambda_functions

  api_id                 = aws_apigatewayv2_api.elysian.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.elysian[each.key].invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Lambda Permissions
resource "aws_lambda_permission" "elysian_apigateway" {
  for_each = local.lambda_functions

  statement_id  = "AllowAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.elysian[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "\${aws_apigatewayv2_api.elysian.execution_arn}/*/*"
}

# API Gateway Routes
resource "aws_apigatewayv2_route" "elysian" {
  for_each = var.api_routes

  api_id    = aws_apigatewayv2_api.elysian.id
  route_key = each.value.route_key
  target    = "integrations/\${aws_apigatewayv2_integration.elysian[each.value.lambda_key].id}"
}

# API Gateway Stage
resource "aws_apigatewayv2_stage" "elysian" {
  api_id      = aws_apigatewayv2_api.elysian.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags
}
`;

/**
 * Smart append to main.tf - only add if API Gateway resource is missing
 */
export function appendMain(existing: string): string {
	// Check for our specific resource or any API Gateway
	if (
		hasResource(existing, "aws_apigatewayv2_api") ||
		hasResource(existing, "aws_lambda_function")
	) {
		return existing; // Already has Lambda/API Gateway resources
	}
	return existing + MAIN_RESOURCES;
}

/**
 * Outputs template
 */
const OUTPUTS_BLOCK = `
# Elysian: API Endpoint Output
output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_stage.elysian.invoke_url
}
`;

/**
 * Smart append to outputs.tf - only add if api_endpoint output is missing
 */
export function appendOutputs(existing: string): string {
	if (hasOutput(existing, "api_endpoint")) {
		return existing;
	}
	return existing + OUTPUTS_BLOCK;
}

/**
 * Full templates for new files
 */
export const templates = {
	providers: PROVIDERS_BLOCK.trim() + "\n",

	variables: (name: string) =>
		`# Elysian: Terraform Variables

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
  default = "nodejs22.x"
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
  default = "${name}"
}

variable "tags" {
  type    = map(string)
  default = {}
}
`,

	main: MAIN_RESOURCES.trim() + "\n",

	outputs: `# Elysian: Outputs

output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_stage.elysian.invoke_url
}
`,
};
