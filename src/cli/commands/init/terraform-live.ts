/**
 * Terraform Live Mode Resources
 * AppSync Events API for bidirectional WebSocket communication during development
 */

/**
 * Check if live.tf content already has AppSync API configured
 */
export function hasAppSyncApi(content: string): boolean {
	return /resource\s+["']aws_appsync_api["']/.test(content);
}

/**
 * Live mode Terraform template
 * These resources are only created when dev_mode = true
 */
export const LIVE_TEMPLATE = `# Elysian Live Mode Infrastructure
# These resources enable real-time communication between AWS/LocalStack and your local machine
# Only created when dev_mode = true

# AppSync Events API for bidirectional WebSocket communication
resource "aws_appsync_api" "elysian_live" {
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
resource "aws_appsync_channel_namespace" "elysian_live" {
  count  = var.dev_mode ? 1 : 0
  api_id = aws_appsync_api.elysian_live[0].api_id
  name   = "elysian"
}

# API key for AppSync authentication
resource "aws_appsync_api_key" "elysian_live" {
  count  = var.dev_mode ? 1 : 0
  api_id = aws_appsync_api.elysian_live[0].api_id
}

# IAM policy for Lambda to access AppSync (dev mode)
resource "aws_iam_role_policy" "elysian_lambda_appsync" {
  count = var.dev_mode ? 1 : 0
  name  = "\${var.api_name}-lambda-appsync"
  role  = aws_iam_role.elysian_lambda.id

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
          aws_appsync_api.elysian_live[0].api_arn,
          "\${aws_appsync_api.elysian_live[0].api_arn}/*"
        ]
      }
    ]
  })
}

# Stub Lambda archive (only in dev mode)
data "archive_file" "elysian_stub" {
  count       = var.dev_mode ? 1 : 0
  type        = "zip"
  source_dir  = "\${path.module}/../dist/__stub__"
  output_path = "\${path.module}/../dist/elysian-stub.zip"
}

# Locals for stub configuration
locals {
  # Stub paths (null when not in dev mode)
  stub_zip_path = var.dev_mode ? data.archive_file.elysian_stub[0].output_path : null
  stub_hash     = var.dev_mode ? data.archive_file.elysian_stub[0].output_base64sha256 : null

  # Dev mode environment variables for Lambda
  dev_environment = var.dev_mode ? {
    ELYSIAN_DEV_MODE           = "true"
    ELYSIAN_APPSYNC_HTTP       = aws_appsync_api.elysian_live[0].dns["HTTP"]
    ELYSIAN_APPSYNC_REALTIME   = aws_appsync_api.elysian_live[0].dns["REALTIME"]
    ELYSIAN_APPSYNC_API_KEY    = aws_appsync_api_key.elysian_live[0].api_key_id
    ELYSIAN_APP_NAME           = var.api_name
  } : {}
}
`;

/**
 * Live mode outputs template
 */
export const LIVE_OUTPUTS_TEMPLATE = `
# Elysian Live Mode Outputs
output "appsync_http_endpoint" {
  description = "AppSync HTTP endpoint for Live mode"
  value       = var.dev_mode ? aws_appsync_api.elysian_live[0].dns["HTTP"] : null
}

output "appsync_realtime_endpoint" {
  description = "AppSync WebSocket endpoint for Live mode"
  value       = var.dev_mode ? aws_appsync_api.elysian_live[0].dns["REALTIME"] : null
}

output "appsync_api_key" {
  description = "AppSync API key for Live mode"
  value       = var.dev_mode ? aws_appsync_api_key.elysian_live[0].api_key_id : null
  sensitive   = true
}
`;

/**
 * Full live.tf template for new files
 */
export const templates = {
	live: LIVE_TEMPLATE.trim() + "\n",
};

/**
 * Append live outputs to existing outputs.tf if missing
 */
export function appendLiveOutputs(existing: string): string {
	if (existing.includes("appsync_http_endpoint")) {
		return existing; // Already has live outputs
	}
	return existing + LIVE_OUTPUTS_TEMPLATE;
}
