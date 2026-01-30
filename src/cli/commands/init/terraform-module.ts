/**
 * Terraform Module Templates
 *
 * This file contains the templates for the Elysian Terraform module.
 * The module encapsulates all Elysian infrastructure to avoid polluting
 * the user's Terraform namespace.
 *
 * Structure:
 * terraform/
 * ├── main.tf                 # User's entry point - module call + their resources
 * ├── variables.tf            # Root variables passed to module
 * ├── outputs.tf              # Root outputs (references module outputs)
 * ├── providers.tf            # Provider configuration
 * └── modules/
 *     └── elysian/            # Elysian-managed module
 *         ├── main.tf         # Lambda + API Gateway
 *         ├── iam.tf          # IAM roles and policies
 *         ├── live.tf         # Dev mode AppSync
 *         ├── variables.tf    # Module inputs
 *         └── outputs.tf      # Module outputs
 */

// ============================================================================
// MODULE FILES (terraform/modules/elysian/)
// ============================================================================

const MODULE_HEADER = `# =============================================================================
# ELYSIAN MANAGED - DO NOT EDIT
# =============================================================================
# This file is managed by Elysian. Manual changes will be overwritten.
# To customize your infrastructure, modify the root terraform files instead.
# =============================================================================

`;

/**
 * Module variables.tf - All inputs for the Elysian module
 */
export const MODULE_VARIABLES = `${MODULE_HEADER}# Core Configuration
variable "api_name" {
  description = "Name for the API and related resources"
  type        = string
}

variable "lambda_names" {
  description = "List of API route Lambda function names to create"
  type        = list(string)
  default     = []
}

variable "generic_lambdas" {
  description = "List of generic Lambda configurations (non-API lambdas)"
  type = list(object({
    name           = string
    bundle_name    = string
    trigger_type   = string # sqs, s3, schedule, sns, kinesis, or empty
    trigger_config = any    # Optional config for auto-creating trigger resources
  }))
  default = []
}

variable "api_routes" {
  description = "API Gateway routes mapping"
  type = map(object({
    lambda_key      = string
    route_key       = string
    path_parameters = list(string)
  }))
  default = {}
}

# Lambda Defaults
variable "lambda_runtime" {
  description = "Lambda runtime"
  type        = string
  default     = "nodejs22.x"
}

variable "lambda_memory_size" {
  description = "Default Lambda memory size in MB"
  type        = number
  default     = 256
}

variable "lambda_timeout" {
  description = "Default Lambda timeout in seconds"
  type        = number
  default     = 30
}

variable "lambda_architecture" {
  description = "Lambda CPU architecture (arm64 or x86_64)"
  type        = string
  default     = "arm64"
}

# Environment Variables
variable "lambda_environment" {
  description = "Global environment variables for all Lambda functions"
  type        = map(string)
  default     = {}
}

variable "lambda_environment_per_function" {
  description = "Per-function environment variable overrides (merged with global)"
  type        = map(map(string))
  default     = {}
}

# IAM Extensions
variable "additional_policy_arns" {
  description = "Additional IAM policy ARNs to attach to Lambda execution role"
  type        = list(string)
  default     = []
}

# VPC Configuration
variable "vpc_config" {
  description = "VPC configuration for Lambda functions"
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

# Concurrency
variable "reserved_concurrent_executions" {
  description = "Default reserved concurrency (-1 = unreserved)"
  type        = number
  default     = -1
}

variable "provisioned_concurrency" {
  description = "Per-function provisioned concurrency config"
  type = map(object({
    provisioned_concurrent_executions = number
  }))
  default = {}
}

# Observability
variable "enable_xray_tracing" {
  description = "Enable AWS X-Ray tracing for Lambda functions"
  type        = bool
  default     = false
}

variable "xray_tracing_mode" {
  description = "X-Ray tracing mode: Active or PassThrough"
  type        = string
  default     = "Active"
}

# Lambda Layers
variable "lambda_layers" {
  description = "List of Lambda layer ARNs to attach to all functions"
  type        = list(string)
  default     = []
}

variable "lambda_layers_per_function" {
  description = "Per-function Lambda layers (merged with global)"
  type        = map(list(string))
  default     = {}
}

# Dead Letter Queue
variable "dead_letter_config" {
  description = "Dead letter queue configuration for failed invocations"
  type = object({
    target_arn = string
  })
  default = null
}

# File System (EFS)
variable "file_system_config" {
  description = "EFS file system configuration"
  type = object({
    arn              = string
    local_mount_path = string
  })
  default = null
}

# Dev Mode
variable "dev_mode" {
  description = "Enable live development mode (uses stub lambdas with AppSync)"
  type        = bool
  default     = false
}

# Tags
variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
`;

/**
 * Module main.tf - Lambda functions and API Gateway
 */
export const MODULE_MAIN = `${MODULE_HEADER}# Lambda Functions and API Gateway

locals {
  # API route Lambda function configurations
  lambda_functions = {
    for name in var.lambda_names : name => {
      filename         = "\${path.module}/../../../dist/\${name}.zip"
      handler          = "index.handler"
      source_code_hash = filebase64sha256("\${path.module}/../../../dist/\${name}.zip")
    }
  }

  # Generic Lambda function configurations
  generic_lambda_functions = {
    for lambda in var.generic_lambdas : lambda.bundle_name => {
      name           = lambda.name
      bundle_name    = lambda.bundle_name
      trigger_type   = lambda.trigger_type
      trigger_config = lambda.trigger_config
      filename         = "\${path.module}/../../../dist/\${lambda.bundle_name}.zip"
      handler          = "index.handler"
      source_code_hash = filebase64sha256("\${path.module}/../../../dist/\${lambda.bundle_name}.zip")
    }
  }

  # Merge global + per-function environment variables (API routes)
  lambda_env_merged = {
    for name in var.lambda_names : name => merge(
      var.lambda_environment,
      lookup(var.lambda_environment_per_function, name, {})
    )
  }

  # Merge global + per-function environment variables (generic lambdas)
  generic_lambda_env_merged = {
    for lambda in var.generic_lambdas : lambda.bundle_name => merge(
      var.lambda_environment,
      lookup(var.lambda_environment_per_function, lambda.bundle_name, {})
    )
  }

  # Merge global + per-function layers (API routes)
  lambda_layers_merged = {
    for name in var.lambda_names : name => distinct(concat(
      var.lambda_layers,
      lookup(var.lambda_layers_per_function, name, [])
    ))
  }

  # Merge global + per-function layers (generic lambdas)
  generic_lambda_layers_merged = {
    for lambda in var.generic_lambdas : lambda.bundle_name => distinct(concat(
      var.lambda_layers,
      lookup(var.lambda_layers_per_function, lambda.bundle_name, [])
    ))
  }
}

# API Gateway HTTP API
resource "aws_apigatewayv2_api" "this" {
  name          = var.api_name
  protocol_type = "HTTP"
  tags          = var.tags
}

# API Route Lambda Functions
resource "aws_lambda_function" "this" {
  for_each = local.lambda_functions

  function_name = each.key
  role          = aws_iam_role.lambda.arn
  handler       = each.value.handler
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]

  # Use stub in dev mode, real code otherwise
  filename         = var.dev_mode ? local.stub_zip_path : each.value.filename
  source_code_hash = var.dev_mode ? local.stub_hash : each.value.source_code_hash

  memory_size = var.lambda_memory_size
  timeout     = var.dev_mode ? 900 : var.lambda_timeout # 15 min timeout in dev mode

  reserved_concurrent_executions = var.reserved_concurrent_executions

  # Environment variables (global + per-function + dev mode)
  environment {
    variables = merge(
      local.lambda_env_merged[each.key],
      var.dev_mode ? merge(local.dev_environment, {
        ELYSIAN_LAMBDA_NAME = each.key
      }) : {}
    )
  }

  # Lambda layers
  layers = length(local.lambda_layers_merged[each.key]) > 0 ? local.lambda_layers_merged[each.key] : null

  # X-Ray tracing
  dynamic "tracing_config" {
    for_each = var.enable_xray_tracing ? [1] : []
    content {
      mode = var.xray_tracing_mode
    }
  }

  # VPC configuration
  dynamic "vpc_config" {
    for_each = var.vpc_config != null ? [var.vpc_config] : []
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  # Dead letter queue
  dynamic "dead_letter_config" {
    for_each = var.dead_letter_config != null ? [var.dead_letter_config] : []
    content {
      target_arn = dead_letter_config.value.target_arn
    }
  }

  # EFS file system
  dynamic "file_system_config" {
    for_each = var.file_system_config != null ? [var.file_system_config] : []
    content {
      arn              = file_system_config.value.arn
      local_mount_path = file_system_config.value.local_mount_path
    }
  }

  tags = var.tags
}

# Generic Lambda Functions (non-API, event-triggered)
resource "aws_lambda_function" "generic" {
  for_each = local.generic_lambda_functions

  function_name = each.key
  role          = aws_iam_role.lambda.arn
  handler       = each.value.handler
  runtime       = var.lambda_runtime
  architectures = [var.lambda_architecture]

  # Use stub in dev mode, real code otherwise
  filename         = var.dev_mode ? local.stub_zip_path : each.value.filename
  source_code_hash = var.dev_mode ? local.stub_hash : each.value.source_code_hash

  memory_size = var.lambda_memory_size
  timeout     = var.dev_mode ? 900 : var.lambda_timeout

  reserved_concurrent_executions = var.reserved_concurrent_executions

  # Environment variables (global + per-function + dev mode)
  environment {
    variables = merge(
      local.generic_lambda_env_merged[each.key],
      var.dev_mode ? merge(local.dev_environment, {
        ELYSIAN_LAMBDA_NAME = each.key
      }) : {}
    )
  }

  # Lambda layers
  layers = length(local.generic_lambda_layers_merged[each.key]) > 0 ? local.generic_lambda_layers_merged[each.key] : null

  # X-Ray tracing
  dynamic "tracing_config" {
    for_each = var.enable_xray_tracing ? [1] : []
    content {
      mode = var.xray_tracing_mode
    }
  }

  # VPC configuration
  dynamic "vpc_config" {
    for_each = var.vpc_config != null ? [var.vpc_config] : []
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  # Dead letter queue
  dynamic "dead_letter_config" {
    for_each = var.dead_letter_config != null ? [var.dead_letter_config] : []
    content {
      target_arn = dead_letter_config.value.target_arn
    }
  }

  # EFS file system
  dynamic "file_system_config" {
    for_each = var.file_system_config != null ? [var.file_system_config] : []
    content {
      arn              = file_system_config.value.arn
      local_mount_path = file_system_config.value.local_mount_path
    }
  }

  tags = var.tags
}

# Provisioned Concurrency (optional, per-function) - API routes
resource "aws_lambda_provisioned_concurrency_config" "this" {
  for_each = var.provisioned_concurrency

  function_name                     = aws_lambda_function.this[each.key].function_name
  qualifier                         = aws_lambda_function.this[each.key].version
  provisioned_concurrent_executions = each.value.provisioned_concurrent_executions
}

# API Gateway Integrations
resource "aws_apigatewayv2_integration" "this" {
  for_each = local.lambda_functions

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this[each.key].invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Lambda Permissions for API Gateway
resource "aws_lambda_permission" "apigateway" {
  for_each = local.lambda_functions

  statement_id  = "AllowAPIGateway"
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
  tags        = var.tags
}
`;

/**
 * Module iam.tf - IAM roles and policies
 */
export const MODULE_IAM = `${MODULE_HEADER}# IAM Roles and Policies

locals {
  # Identify lambdas by trigger type
  sqs_lambdas     = [for l in var.generic_lambdas : l.bundle_name if l.trigger_type == "sqs"]
  s3_lambdas      = [for l in var.generic_lambdas : l.bundle_name if l.trigger_type == "s3"]
  kinesis_lambdas = [for l in var.generic_lambdas : l.bundle_name if l.trigger_type == "kinesis"]
  
  # Check if we need trigger-specific policies
  has_sqs_triggers     = length(local.sqs_lambdas) > 0
  has_s3_triggers      = length(local.s3_lambdas) > 0
  has_kinesis_triggers = length(local.kinesis_lambdas) > 0
}

# Lambda Execution Role
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

# Basic Lambda Execution Policy
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# VPC Access Policy (conditional)
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  count = var.vpc_config != null ? 1 : 0

  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# X-Ray Tracing Policy (conditional)
resource "aws_iam_role_policy_attachment" "lambda_xray" {
  count = var.enable_xray_tracing ? 1 : 0

  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Additional User-Provided Policies
resource "aws_iam_role_policy_attachment" "additional" {
  count = length(var.additional_policy_arns)

  role       = aws_iam_role.lambda.name
  policy_arn = var.additional_policy_arns[count.index]
}

# =============================================================================
# Trigger-based IAM Policies for Generic Lambdas
# These grant permissions based on the trigger type specified in defineLambda()
# =============================================================================

# SQS Trigger Policy - allows reading and deleting messages from any SQS queue
# User must set up the actual event source mapping in their Terraform
resource "aws_iam_role_policy" "sqs_trigger" {
  count = local.has_sqs_triggers ? 1 : 0
  name  = "\${var.api_name}-sqs-trigger"
  role  = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ]
        Resource = "*"
      }
    ]
  })
}

# S3 Trigger Policy - allows reading objects from any S3 bucket
# User must set up the S3 bucket notification in their Terraform
resource "aws_iam_role_policy" "s3_trigger" {
  count = local.has_s3_triggers ? 1 : 0
  name  = "\${var.api_name}-s3-trigger"
  role  = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetObjectTagging",
          "s3:ListBucket"
        ]
        Resource = "*"
      }
    ]
  })
}

# Kinesis Trigger Policy - allows reading from any Kinesis stream
# User must set up the actual event source mapping in their Terraform
resource "aws_iam_role_policy" "kinesis_trigger" {
  count = local.has_kinesis_triggers ? 1 : 0
  name  = "\${var.api_name}-kinesis-trigger"
  role  = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kinesis:GetRecords",
          "kinesis:GetShardIterator",
          "kinesis:DescribeStream",
          "kinesis:DescribeStreamSummary",
          "kinesis:ListShards",
          "kinesis:ListStreams"
        ]
        Resource = "*"
      }
    ]
  })
}
`;

/**
 * Module live.tf - Dev mode AppSync resources
 */
export const MODULE_LIVE = `${MODULE_HEADER}# Live Development Mode Resources
# These resources enable real-time communication between AWS/LocalStack and your local machine
# Only created when dev_mode = true

# AppSync Events API for bidirectional WebSocket communication
resource "aws_appsync_api" "live" {
  count = var.dev_mode ? 1 : 0
  name  = "\${var.api_name}-live"

  event_config {
    auth_provider {
      auth_type = "API_KEY"
    }
    connection_auth_mode {
      auth_type = "API_KEY"
    }
    default_publish_auth_mode {
      auth_type = "API_KEY"
    }
    default_subscribe_auth_mode {
      auth_type = "API_KEY"
    }
  }

  tags = var.tags
}

# Channel namespace for Lambda invoke requests/responses
resource "aws_appsync_channel_namespace" "live" {
  count  = var.dev_mode ? 1 : 0
  api_id = aws_appsync_api.live[0].api_id
  name   = "elysian"
}

# API key for AppSync authentication
resource "aws_appsync_api_key" "live" {
  count  = var.dev_mode ? 1 : 0
  api_id = aws_appsync_api.live[0].api_id
}

# IAM policy for Lambda to access AppSync (dev mode)
resource "aws_iam_role_policy" "lambda_appsync" {
  count = var.dev_mode ? 1 : 0
  name  = "\${var.api_name}-lambda-appsync"
  role  = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "appsync:GraphQL",
          "appsync:Connect",
          "appsync:Publish",
          "appsync:Subscribe"
        ]
        Resource = [
          aws_appsync_api.live[0].api_arn,
          "\${aws_appsync_api.live[0].api_arn}/*"
        ]
      }
    ]
  })
}

# Stub Lambda archive (only in dev mode)
data "archive_file" "stub" {
  count       = var.dev_mode ? 1 : 0
  type        = "zip"
  source_dir  = "\${path.module}/../../../dist/__stub__"
  output_path = "\${path.module}/../../../dist/elysian-stub.zip"
}

# Locals for stub configuration and dev environment
locals {
  # Stub paths (null when not in dev mode)
  stub_zip_path = var.dev_mode ? data.archive_file.stub[0].output_path : null
  stub_hash     = var.dev_mode ? data.archive_file.stub[0].output_base64sha256 : null

  # Dev mode environment variables for Lambda
  dev_environment = var.dev_mode ? {
    ELYSIAN_DEV_MODE         = "true"
    ELYSIAN_APPSYNC_HTTP     = aws_appsync_api.live[0].dns["HTTP"]
    ELYSIAN_APPSYNC_REALTIME = aws_appsync_api.live[0].dns["REALTIME"]
    ELYSIAN_APPSYNC_API_KEY  = aws_appsync_api_key.live[0].api_key_id
    ELYSIAN_APP_NAME         = var.api_name
  } : {}
}
`;

/**
 * Module outputs.tf - All module outputs
 */
export const MODULE_OUTPUTS = `${MODULE_HEADER}# Module Outputs

# API Gateway
output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_stage.this.invoke_url
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = aws_apigatewayv2_api.this.id
}

output "api_gateway_arn" {
  description = "API Gateway ARN"
  value       = aws_apigatewayv2_api.this.arn
}

output "api_gateway_execution_arn" {
  description = "API Gateway execution ARN"
  value       = aws_apigatewayv2_api.this.execution_arn
}

# Lambda IAM
output "lambda_role_name" {
  description = "Lambda execution role name (for attaching additional policies)"
  value       = aws_iam_role.lambda.name
}

output "lambda_role_arn" {
  description = "Lambda execution role ARN"
  value       = aws_iam_role.lambda.arn
}

output "lambda_role_id" {
  description = "Lambda execution role ID"
  value       = aws_iam_role.lambda.id
}

# API Route Lambda Functions
output "lambda_functions" {
  description = "Map of API route Lambda function details"
  value = {
    for k, v in aws_lambda_function.this : k => {
      arn           = v.arn
      invoke_arn    = v.invoke_arn
      function_name = v.function_name
      qualified_arn = v.qualified_arn
    }
  }
}

output "lambda_function_arns" {
  description = "Map of API route Lambda function ARNs by name"
  value       = { for k, v in aws_lambda_function.this : k => v.arn }
}

output "lambda_function_names" {
  description = "List of all API route Lambda function names"
  value       = [for k, v in aws_lambda_function.this : v.function_name]
}

# Generic Lambda Functions
output "generic_lambda_functions" {
  description = "Map of generic Lambda function details"
  value = {
    for k, v in aws_lambda_function.generic : k => {
      arn           = v.arn
      invoke_arn    = v.invoke_arn
      function_name = v.function_name
      qualified_arn = v.qualified_arn
    }
  }
}

output "generic_lambda_function_arns" {
  description = "Map of generic Lambda function ARNs by name"
  value       = { for k, v in aws_lambda_function.generic : k => v.arn }
}

output "generic_lambda_function_names" {
  description = "List of all generic Lambda function names"
  value       = [for k, v in aws_lambda_function.generic : v.function_name]
}

# All Lambda Functions (combined)
output "all_lambda_function_arns" {
  description = "Map of all Lambda function ARNs (API routes + generic)"
  value = merge(
    { for k, v in aws_lambda_function.this : k => v.arn },
    { for k, v in aws_lambda_function.generic : k => v.arn }
  )
}

# Dev Mode Outputs (conditional)
output "appsync_http_endpoint" {
  description = "AppSync HTTP endpoint for live mode"
  value       = var.dev_mode ? aws_appsync_api.live[0].dns["HTTP"] : null
}

output "appsync_realtime_endpoint" {
  description = "AppSync WebSocket endpoint for live mode"
  value       = var.dev_mode ? aws_appsync_api.live[0].dns["REALTIME"] : null
}

output "appsync_api_key" {
  description = "AppSync API key for live mode"
  value       = var.dev_mode ? aws_appsync_api_key.live[0].api_key_id : null
  sensitive   = true
}

# =============================================================================
# Auto-Created Trigger Resource Outputs
# =============================================================================

# SQS Queues (auto-created)
output "sqs_queue_arns" {
  description = "Map of auto-created SQS queue ARNs by lambda bundle name"
  value       = { for k, v in aws_sqs_queue.trigger : k => v.arn }
}

output "sqs_queue_urls" {
  description = "Map of auto-created SQS queue URLs by lambda bundle name"
  value       = { for k, v in aws_sqs_queue.trigger : k => v.url }
}

# SNS Topics (auto-created)
output "sns_topic_arns" {
  description = "Map of auto-created SNS topic ARNs by lambda bundle name"
  value       = { for k, v in aws_sns_topic.trigger : k => v.arn }
}

# Kinesis Streams (auto-created)
output "kinesis_stream_arns" {
  description = "Map of auto-created Kinesis stream ARNs by lambda bundle name"
  value       = { for k, v in aws_kinesis_stream.trigger : k => v.arn }
}

output "kinesis_stream_names" {
  description = "Map of auto-created Kinesis stream names by lambda bundle name"
  value       = { for k, v in aws_kinesis_stream.trigger : k => v.name }
}

# EventBridge Rules (schedule triggers)
output "schedule_rule_arns" {
  description = "Map of auto-created EventBridge rule ARNs by lambda bundle name"
  value       = { for k, v in aws_cloudwatch_event_rule.schedule : k => v.arn }
}
`;

// ============================================================================
// ROOT FILES (terraform/)
// ============================================================================

/**
 * Root providers.tf
 */
export const ROOT_PROVIDERS = `# Terraform Provider Configuration

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
 * Root variables.tf - generates with project name
 */
export function getRootVariables(name: string): string {
	return `# Terraform Variables
# Customize these values or add your own variables

variable "region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-2"
}

variable "api_name" {
  description = "Name for the API and related resources"
  type        = string
  default     = "${name}"
}

variable "dev_mode" {
  description = "Enable live development mode"
  type        = bool
  default     = false
}

variable "lambda_names" {
  description = "List of API route Lambda function names (auto-populated by elysian)"
  type        = list(string)
  default     = []
}

variable "generic_lambdas" {
  description = "List of generic Lambda configurations (auto-populated by elysian)"
  type = list(object({
    name           = string
    bundle_name    = string
    trigger_type   = string
    trigger_config = any
  }))
  default = []
}

variable "api_routes" {
  description = "API Gateway routes (auto-populated by elysian)"
  type = map(object({
    lambda_key      = string
    route_key       = string
    path_parameters = list(string)
  }))
  default = {}
}

variable "lambda_runtime" {
  description = "Lambda runtime"
  type        = string
  default     = "nodejs22.x"
}

variable "lambda_memory_size" {
  description = "Lambda memory size in MB"
  type        = number
  default     = 256
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 30
}

variable "lambda_environment" {
  description = "Global environment variables for all Lambda functions"
  type        = map(string)
  default     = {}
}

variable "enable_xray_tracing" {
  description = "Enable AWS X-Ray tracing"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
`;
}

/**
 * Root main.tf - module call with examples
 */
export function getRootMain(name: string): string {
	return `# Elysian API Infrastructure
# Add your own resources here alongside the elysian module

module "elysian" {
  source = "./modules/elysian"

  # Core configuration (required)
  api_name        = var.api_name
  dev_mode        = var.dev_mode
  lambda_names    = var.lambda_names
  generic_lambdas = var.generic_lambdas
  api_routes      = var.api_routes

  # Lambda defaults
  lambda_runtime     = var.lambda_runtime
  lambda_memory_size = var.lambda_memory_size
  lambda_timeout     = var.lambda_timeout

  # Environment variables
  lambda_environment = var.lambda_environment

  # Per-function environment overrides (uncomment to use)
  # lambda_environment_per_function = {
  #   "my-lambda" = {
  #     SPECIAL_VAR = "value"
  #   }
  # }

  # Observability
  enable_xray_tracing = var.enable_xray_tracing

  # Additional IAM policies (uncomment to use)
  # additional_policy_arns = [
  #   aws_iam_policy.custom.arn,
  # ]

  # VPC configuration (uncomment to use)
  # vpc_config = {
  #   subnet_ids         = var.subnet_ids
  #   security_group_ids = var.security_group_ids
  # }

  # Lambda layers (uncomment to use)
  # lambda_layers = ["arn:aws:lambda:region:account:layer:name:version"]

  # Dead letter queue (uncomment to use)
  # dead_letter_config = {
  #   target_arn = aws_sqs_queue.dlq.arn
  # }

  # Tags
  tags = var.tags
}

# =============================================================================
# ADD YOUR CUSTOM RESOURCES BELOW
# =============================================================================

# Example: DynamoDB table
# resource "aws_dynamodb_table" "my_table" {
#   name         = "\${var.api_name}-data"
#   billing_mode = "PAY_PER_REQUEST"
#   hash_key     = "id"
#
#   attribute {
#     name = "id"
#     type = "S"
#   }
# }

# Example: Attach custom IAM policy to Lambda role
# resource "aws_iam_role_policy" "custom" {
#   name = "\${var.api_name}-custom"
#   role = module.elysian.lambda_role_name
#
#   policy = jsonencode({
#     Version = "2012-10-17"
#     Statement = [{
#       Effect   = "Allow"
#       Action   = ["dynamodb:*"]
#       Resource = aws_dynamodb_table.my_table.arn
#     }]
#   })
# }

# =============================================================================
# WIRING GENERIC LAMBDA TRIGGERS
# =============================================================================
# Generic lambdas with triggers require manual wiring. Elysian generates
# the Lambda functions and grants appropriate IAM permissions, but you must
# create the event source mappings and resource configurations yourself.

# Example: SQS Event Source Mapping
# resource "aws_lambda_event_source_mapping" "process_queue" {
#   event_source_arn = aws_sqs_queue.my_queue.arn
#   function_name    = module.elysian.generic_lambda_function_arns["${name}-process-queue"]
#   batch_size       = 10
# }

# Example: S3 Bucket Notification
# resource "aws_s3_bucket_notification" "bucket_notification" {
#   bucket = aws_s3_bucket.my_bucket.id
#
#   lambda_function {
#     lambda_function_arn = module.elysian.generic_lambda_function_arns["${name}-process-uploads"]
#     events              = ["s3:ObjectCreated:*"]
#   }
# }

# Example: Lambda Permission for S3
# resource "aws_lambda_permission" "allow_s3" {
#   statement_id  = "AllowS3"
#   action        = "lambda:InvokeFunction"
#   function_name = module.elysian.generic_lambda_function_arns["${name}-process-uploads"]
#   principal     = "s3.amazonaws.com"
#   source_arn    = aws_s3_bucket.my_bucket.arn
# }

# Example: EventBridge Scheduled Rule
# resource "aws_cloudwatch_event_rule" "daily" {
#   name                = "\${var.api_name}-daily-task"
#   schedule_expression = "rate(1 day)"
# }
#
# resource "aws_cloudwatch_event_target" "daily" {
#   rule      = aws_cloudwatch_event_rule.daily.name
#   target_id = "daily-task"
#   arn       = module.elysian.generic_lambda_function_arns["${name}-daily-task"]
# }
#
# resource "aws_lambda_permission" "allow_eventbridge" {
#   statement_id  = "AllowEventBridge"
#   action        = "lambda:InvokeFunction"
#   function_name = module.elysian.generic_lambda_function_arns["${name}-daily-task"]
#   principal     = "events.amazonaws.com"
#   source_arn    = aws_cloudwatch_event_rule.daily.arn
# }
`;
}

/**
 * Root outputs.tf
 */
export const ROOT_OUTPUTS = `# Outputs
# Reference module outputs and add your own

output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = module.elysian.api_endpoint
}

output "lambda_role_name" {
  description = "Lambda execution role name (for attaching additional policies)"
  value       = module.elysian.lambda_role_name
}

output "lambda_role_arn" {
  description = "Lambda execution role ARN"
  value       = module.elysian.lambda_role_arn
}

# API Route Lambda outputs
output "lambda_function_arns" {
  description = "Map of API route Lambda function ARNs"
  value       = module.elysian.lambda_function_arns
}

# Generic Lambda outputs
output "generic_lambda_function_arns" {
  description = "Map of generic Lambda function ARNs"
  value       = module.elysian.generic_lambda_function_arns
}

# All lambdas (combined)
output "all_lambda_function_arns" {
  description = "Map of all Lambda function ARNs"
  value       = module.elysian.all_lambda_function_arns
}

# =============================================================================
# Auto-Created Trigger Resources
# =============================================================================

output "sqs_queue_arns" {
  description = "Map of auto-created SQS queue ARNs"
  value       = module.elysian.sqs_queue_arns
}

output "sqs_queue_urls" {
  description = "Map of auto-created SQS queue URLs"
  value       = module.elysian.sqs_queue_urls
}

output "sns_topic_arns" {
  description = "Map of auto-created SNS topic ARNs"
  value       = module.elysian.sns_topic_arns
}

output "kinesis_stream_arns" {
  description = "Map of auto-created Kinesis stream ARNs"
  value       = module.elysian.kinesis_stream_arns
}

output "schedule_rule_arns" {
  description = "Map of auto-created EventBridge schedule rule ARNs"
  value       = module.elysian.schedule_rule_arns
}

# Dev mode outputs
output "appsync_http_endpoint" {
  description = "AppSync HTTP endpoint (dev mode only)"
  value       = module.elysian.appsync_http_endpoint
}

output "appsync_realtime_endpoint" {
  description = "AppSync WebSocket endpoint (dev mode only)"
  value       = module.elysian.appsync_realtime_endpoint
}

output "appsync_api_key" {
  description = "AppSync API key (dev mode only)"
  value       = module.elysian.appsync_api_key
  sensitive   = true
}
`;

/**
 * Module triggers.tf - Auto-created trigger resources
 * These resources are created when trigger config is provided in defineLambda()
 */
export const MODULE_TRIGGERS = `${MODULE_HEADER}# Auto-Created Trigger Resources
# These resources are created when defineLambda() includes trigger config
# (not just a trigger type string, but actual configuration)

locals {
  # Lambdas with schedule triggers that have config (auto-create)
  schedule_lambdas_to_create = {
    for l in var.generic_lambdas : l.bundle_name => l
    if l.trigger_type == "schedule" && l.trigger_config != null
  }

  # Lambdas with SQS triggers that have config (auto-create)
  sqs_lambdas_to_create = {
    for l in var.generic_lambdas : l.bundle_name => l
    if l.trigger_type == "sqs" && l.trigger_config != null
  }

  # Lambdas with SNS triggers that have config (auto-create)
  sns_lambdas_to_create = {
    for l in var.generic_lambdas : l.bundle_name => l
    if l.trigger_type == "sns" && l.trigger_config != null
  }

  # Lambdas with Kinesis triggers that have config (auto-create)
  kinesis_lambdas_to_create = {
    for l in var.generic_lambdas : l.bundle_name => l
    if l.trigger_type == "kinesis" && l.trigger_config != null
  }
}

# =============================================================================
# SCHEDULE TRIGGERS (EventBridge Rules)
# =============================================================================

# EventBridge rule for scheduled lambdas
resource "aws_cloudwatch_event_rule" "schedule" {
  for_each = local.schedule_lambdas_to_create

  name                = "\${var.api_name}-\${each.key}"
  description         = "Schedule trigger for \${each.key}"
  schedule_expression = each.value.trigger_config.schedule_expression
  state               = lookup(each.value.trigger_config, "enabled", true) ? "ENABLED" : "DISABLED"

  tags = var.tags
}

# EventBridge target for scheduled lambdas
resource "aws_cloudwatch_event_target" "schedule" {
  for_each = local.schedule_lambdas_to_create

  rule      = aws_cloudwatch_event_rule.schedule[each.key].name
  target_id = each.key
  arn       = aws_lambda_function.generic[each.key].arn
}

# Lambda permission for EventBridge to invoke scheduled lambdas
resource "aws_lambda_permission" "schedule" {
  for_each = local.schedule_lambdas_to_create

  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generic[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule[each.key].arn
}

# =============================================================================
# SQS TRIGGERS (Auto-created queues)
# =============================================================================

# SQS queue for lambdas with SQS trigger config
resource "aws_sqs_queue" "trigger" {
  for_each = local.sqs_lambdas_to_create

  name                       = "\${var.api_name}-\${each.key}"
  visibility_timeout_seconds = lookup(each.value.trigger_config, "visibilityTimeout", 30)
  message_retention_seconds  = lookup(each.value.trigger_config, "messageRetentionSeconds", 345600)
  fifo_queue                 = lookup(each.value.trigger_config, "fifo", false)
  content_based_deduplication = lookup(each.value.trigger_config, "fifo", false) ? lookup(each.value.trigger_config, "contentBasedDeduplication", false) : null

  tags = var.tags
}

# Event source mapping for SQS -> Lambda
resource "aws_lambda_event_source_mapping" "sqs" {
  for_each = local.sqs_lambdas_to_create

  event_source_arn = aws_sqs_queue.trigger[each.key].arn
  function_name    = aws_lambda_function.generic[each.key].arn
  batch_size       = lookup(each.value.trigger_config, "batchSize", 10)
  enabled          = true
}

# =============================================================================
# SNS TRIGGERS (Auto-created topics)
# =============================================================================

# SNS topic for lambdas with SNS trigger config
resource "aws_sns_topic" "trigger" {
  for_each = local.sns_lambdas_to_create

  name = "\${var.api_name}-\${each.key}"
  tags = var.tags
}

# SNS subscription for Lambda
resource "aws_sns_topic_subscription" "trigger" {
  for_each = local.sns_lambdas_to_create

  topic_arn = aws_sns_topic.trigger[each.key].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.generic[each.key].arn

  # Filter policy if provided
  filter_policy = lookup(each.value.trigger_config, "filterPolicy", null) != null ? jsonencode(each.value.trigger_config.filterPolicy) : null
}

# Lambda permission for SNS to invoke
resource "aws_lambda_permission" "sns" {
  for_each = local.sns_lambdas_to_create

  statement_id  = "AllowSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generic[each.key].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.trigger[each.key].arn
}

# =============================================================================
# KINESIS TRIGGERS (Auto-created streams)
# =============================================================================

# Kinesis stream for lambdas with Kinesis trigger config
resource "aws_kinesis_stream" "trigger" {
  for_each = local.kinesis_lambdas_to_create

  name             = "\${var.api_name}-\${each.key}"
  shard_count      = lookup(each.value.trigger_config, "shardCount", 1)
  retention_period = lookup(each.value.trigger_config, "retentionPeriodHours", 24)

  tags = var.tags
}

# Event source mapping for Kinesis -> Lambda
resource "aws_lambda_event_source_mapping" "kinesis" {
  for_each = local.kinesis_lambdas_to_create

  event_source_arn  = aws_kinesis_stream.trigger[each.key].arn
  function_name     = aws_lambda_function.generic[each.key].arn
  batch_size        = lookup(each.value.trigger_config, "batchSize", 100)
  starting_position = lookup(each.value.trigger_config, "startingPosition", "LATEST")
  enabled           = true
}
`;

// ============================================================================
// TEMPLATE EXPORTS (for scaffold.ts)
// ============================================================================

export const moduleTemplates = {
	variables: MODULE_VARIABLES,
	main: MODULE_MAIN,
	iam: MODULE_IAM,
	live: MODULE_LIVE,
	triggers: MODULE_TRIGGERS,
	outputs: MODULE_OUTPUTS,
};

export const rootTemplates = {
	providers: ROOT_PROVIDERS,
	variables: getRootVariables,
	main: getRootMain,
	outputs: ROOT_OUTPUTS,
};
