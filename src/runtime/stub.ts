/**
 * Elysian Live Mode Stub Lambda
 *
 * This stub Lambda is deployed to AWS/LocalStack in dev mode.
 * It forwards Lambda invocations to the local machine via AppSync Events WebSocket
 * and waits for the response, then returns it to the caller.
 *
 * Flow:
 * 1. Lambda receives invocation from API Gateway
 * 2. Connects to AppSync WebSocket (if not already connected)
 * 3. Publishes invocation request to AppSync channel
 * 4. Waits for response on the same WebSocket connection
 * 5. Returns response to caller
 *
 * Environment Variables:
 * - ELYSIAN_DEV_MODE: "true" to enable stub behavior
 * - ELYSIAN_APPSYNC_HTTP: AppSync HTTP endpoint
 * - ELYSIAN_APPSYNC_REALTIME: AppSync WebSocket endpoint
 * - ELYSIAN_APPSYNC_API_KEY: AppSync API key
 * - ELYSIAN_APP_NAME: Application name for channel namespace
 * - ELYSIAN_LAMBDA_NAME: Name of the Lambda function being invoked
 */

import * as http from "http";
import * as crypto from "crypto";

// Types for Lambda Runtime API

interface LambdaEvent {
	version?: string;
	routeKey?: string;
	rawPath?: string;
	rawQueryString?: string;
	headers?: Record<string, string>;
	requestContext?: {
		http?: {
			method: string;
			path: string;
		};
		requestId?: string;
	};
	body?: string;
	isBase64Encoded?: boolean;
	[key: string]: unknown;
}


interface LambdaContext {
	awsRequestId: string;
	functionName: string;
	functionVersion: string;
	invokedFunctionArn: string;
	memoryLimitInMB: string;
	logGroupName: string;
	logStreamName: string;
	getRemainingTimeInMillis: () => number;
}


interface LambdaResponse {
	statusCode: number;
	body: string;
	headers?: Record<string, string>;
	isBase64Encoded?: boolean;
}

// AppSync Events message types

interface AppSyncMessage {
	type: string;
	id?: string;
	channel?: string;
	events?: string[]; // AWS AppSync Events format (array)
	event?: string; // LocalStack format (single string)
	payload?: unknown;
	errors?: Array<{ errorType?: string; message?: string }>;
}

interface InvokeRequest {
	requestId: string;
	lambdaName: string;
	event: LambdaEvent;
	context: Partial<LambdaContext>;
	timestamp: number;
}

interface InvokeResponse {
	requestId: string;
	response?: LambdaResponse;
	error?: {
		message: string;
		stack?: string;
	};
	timestamp: number;
}

/**
 * Transform LocalStack URLs for Lambda container networking
 * When running inside a LocalStack Lambda container, we need to use
 * LOCALSTACK_HOSTNAME instead of localhost.localstack.cloud
 */
function transformLocalStackUrl(url: string): string {
	const localstackHostname = process.env.LOCALSTACK_HOSTNAME;
	if (!localstackHostname) {
		return url;
	}

	// Check if this is a LocalStack URL (contains localhost.localstack.cloud)
	if (!url.includes("localhost.localstack.cloud")) {
		return url;
	}

	// Extract the port from the original URL (usually 4566)
	const portMatch = url.match(/:(\d+)$/);
	const port = portMatch ? portMatch[1] : "4566";

	// Replace the host with LOCALSTACK_HOSTNAME
	// e.g., "abc123.appsync-realtime-api.localhost.localstack.cloud:4566"
	// becomes "192.168.x.x:4566"
	return `${localstackHostname}:${port}`;
}

// Environment configuration
const config = {
	appSyncHttp: transformLocalStackUrl(process.env.ELYSIAN_APPSYNC_HTTP || ""),
	appSyncRealtime: transformLocalStackUrl(process.env.ELYSIAN_APPSYNC_REALTIME || ""),
	apiKey: process.env.ELYSIAN_APPSYNC_API_KEY || "",
	lambdaName: process.env.ELYSIAN_LAMBDA_NAME || "unknown",
	// Keep original hosts for the Host header (AppSync needs the original host for routing)
	originalAppSyncHost: process.env.ELYSIAN_APPSYNC_HTTP || "",
	originalAppSyncRealtime: process.env.ELYSIAN_APPSYNC_REALTIME || "",
};

// WebSocket connection state
let ws: WebSocket | null = null;
let isConnected = false;
let connectionPromise: Promise<void> | null = null;

// Pending requests waiting for responses
const pendingRequests = new Map<
	string,
	{
		resolve: (response: InvokeResponse) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}
>();

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
	return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Extract host from a URL, handling cases where scheme may be missing
 */
function extractHost(url: string): string {
	// If URL doesn't have a scheme, add one temporarily for parsing
	let urlToParse = url;
	if (!url.includes("://")) {
		urlToParse = `http://${url}`;
	}
	try {
		return new URL(urlToParse).host;
	} catch {
		// Fallback: try to extract host manually
		const withoutScheme = url.replace(/^[a-z]+:\/\//i, "");
		const hostPart = withoutScheme.split(/[/?]/)[0];
		return hostPart;
	}
}

/**
 * Build URL-safe base64 string without padding
 * Required for AppSync Events WebSocket header subprotocol
 */
function toUrlSafeBase64(str: string): string {
	return Buffer.from(str)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Build the AppSync WebSocket URL (without auth params)
 */
function buildWebSocketUrl(): string {
	let realtimeEndpoint = config.appSyncRealtime;

	// Ensure realtime endpoint has ws:// scheme
	if (!realtimeEndpoint.startsWith("ws://") && !realtimeEndpoint.startsWith("wss://")) {
		realtimeEndpoint = `ws://${realtimeEndpoint}`;
	}

	// Ensure the path ends with /event/realtime for Events API
	if (!realtimeEndpoint.includes("/event/realtime")) {
		realtimeEndpoint = realtimeEndpoint.replace(/\/?$/, "/event/realtime");
	}

	return realtimeEndpoint;
}

/**
 * Build the WebSocket subprotocols including auth header
 * AppSync Events expects auth as a subprotocol: header-{base64}
 * Note: We use the original host (not transformed) for the Host header
 * because AppSync validates the host against the API configuration
 */
function buildSubprotocols(): string[] {
	const host = extractHost(config.originalAppSyncHost);
	const header = JSON.stringify({
		host,
		"x-api-key": config.apiKey,
	});

	const headerBase64 = toUrlSafeBase64(header);

	return [`header-${headerBase64}`, "aws-appsync-event-ws"];
}

/**
 * Connect to AppSync WebSocket
 * Uses http.request for WebSocket upgrade to support custom Host header
 * This is necessary for LocalStack Lambda containers where we connect to
 * LOCALSTACK_HOSTNAME but need to send the original AppSync host in the header
 */
async function connect(): Promise<void> {
	if (isConnected && ws?.readyState === WebSocket.OPEN) {
		return;
	}

	if (connectionPromise) {
		return connectionPromise;
	}

	connectionPromise = new Promise<void>((resolve, reject) => {
		const url = buildWebSocketUrl();
		const subprotocols = buildSubprotocols();
		
		// Parse the URL to get host and port
		const parsedUrl = new URL(url);
		const connectHost = parsedUrl.hostname;
		const connectPort = parsedUrl.port || "4566";
		const path = parsedUrl.pathname || "/event/realtime";
		
		// Get the original host for the Host header (for LocalStack routing)
		// Use the original realtime endpoint (not HTTP endpoint) for the Host header
		const originalRealtimeHost = extractHost(config.originalAppSyncRealtime);
		const isLocalStack = !!process.env.LOCALSTACK_HOSTNAME;
		const hostHeader = isLocalStack ? originalRealtimeHost : parsedUrl.host;
		
		console.log("[stub] Connecting to AppSync:", url, "with Host:", hostHeader);

		// Use native WebSocket but construct with proper URL
		// For LocalStack, we need to trick the WebSocket by using the IP but with correct Host
		if (isLocalStack) {
			// For LocalStack Lambda containers, use http module for upgrade with custom Host header
			const wsKey = crypto.randomBytes(16).toString("base64");
			
			const req = http.request({
				hostname: connectHost,
				port: parseInt(connectPort, 10),
				path: path,
				method: "GET",
				headers: {
					"Host": hostHeader,
					"Upgrade": "websocket",
					"Connection": "Upgrade",
					"Sec-WebSocket-Key": wsKey,
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Protocol": subprotocols.join(", "),
				},
			});

			req.on("upgrade", (res: any, socket: any, head: any) => {
				console.log("[stub] WebSocket upgrade successful");
				
				// Create a minimal WebSocket-like wrapper around the raw socket
				ws = createSocketWrapper(socket);
				
				const connectionTimeout = setTimeout(() => {
					if (!isConnected) {
						socket.destroy();
						reject(new Error("WebSocket connection timeout"));
					}
				}, 10000);

				ws.onopen?.(null as any);
				
				// Send connection_init
				console.log("[stub] WebSocket connected, sending connection_init");
				ws.send(JSON.stringify({ type: "connection_init" }));

				ws.onmessage = (event: any) => {
					try {
						const message: AppSyncMessage = JSON.parse(event.data as string);
						handleMessage(message, resolve, reject, connectionTimeout);
					} catch (err) {
						console.error("[stub] Failed to parse message:", err);
					}
				};

				ws.onclose = () => {
					console.log("[stub] WebSocket closed");
					isConnected = false;
					connectionPromise = null;
					ws = null;

					for (const [requestId, pending] of pendingRequests) {
						clearTimeout(pending.timeout);
						pending.reject(new Error("WebSocket connection closed"));
						pendingRequests.delete(requestId);
					}
				};
			});

			req.on("error", (error: any) => {
				console.error("[stub] WebSocket connection error:", error);
				connectionPromise = null;
				reject(new Error(`WebSocket connection error: ${error.message}`));
			});

			req.on("response", (res: any) => {
				// Server responded with HTTP instead of upgrading
				console.error("[stub] Server did not upgrade, status:", res.statusCode);
				connectionPromise = null;
				reject(new Error(`WebSocket upgrade failed with status ${res.statusCode}`));
			});

			req.end();
		} else {
			// For non-LocalStack (real AWS), use native WebSocket
			ws = new WebSocket(url, subprotocols);

			const connectionTimeout = setTimeout(() => {
				if (ws && ws.readyState !== WebSocket.OPEN) {
					ws.close();
					reject(new Error("WebSocket connection timeout"));
				}
			}, 10000);

			ws.onopen = () => {
				console.log("[stub] WebSocket connected, sending connection_init");
				ws!.send(JSON.stringify({ type: "connection_init" }));
			};

			ws.onmessage = (event) => {
				try {
					const message: AppSyncMessage = JSON.parse(event.data as string);
					handleMessage(message, resolve, reject, connectionTimeout);
				} catch (err) {
					console.error("[stub] Failed to parse message:", err);
				}
			};

			ws.onerror = (error) => {
				console.error("[stub] WebSocket error:", error);
				clearTimeout(connectionTimeout);
				isConnected = false;
				connectionPromise = null;
				reject(new Error("WebSocket connection error"));
			};

			ws.onclose = (event) => {
				console.log("[stub] WebSocket closed:", event.code, event.reason);
				isConnected = false;
				connectionPromise = null;
				ws = null;

				for (const [requestId, pending] of pendingRequests) {
					clearTimeout(pending.timeout);
					pending.reject(new Error("WebSocket connection closed"));
					pendingRequests.delete(requestId);
				}
			};
		}
	});

	return connectionPromise;
}

/**
 * Create a WebSocket-like wrapper around a raw socket for LocalStack connections
 */
function createSocketWrapper(socket: any): WebSocket {
	let dataBuffer = "";
	
	const wrapper = {
		readyState: WebSocket.OPEN,
		onopen: null as (() => void) | null,
		onmessage: null as ((event: { data: string }) => void) | null,
		onerror: null as ((error: any) => void) | null,
		onclose: null as (() => void) | null,
		
		send(data: string) {
			// WebSocket frame: text frame with mask
			const payload = Buffer.from(data, "utf8");
			const payloadLength = payload.length;
			
			let frame: Buffer;
			if (payloadLength < 126) {
				frame = Buffer.alloc(6 + payloadLength);
				frame[0] = 0x81; // FIN + text frame
				frame[1] = 0x80 | payloadLength; // Masked + length
			} else if (payloadLength < 65536) {
				frame = Buffer.alloc(8 + payloadLength);
				frame[0] = 0x81;
				frame[1] = 0x80 | 126;
				frame.writeUInt16BE(payloadLength, 2);
			} else {
				frame = Buffer.alloc(14 + payloadLength);
				frame[0] = 0x81;
				frame[1] = 0x80 | 127;
				frame.writeBigUInt64BE(BigInt(payloadLength), 2);
			}
			
			// Generate mask
			const maskOffset = payloadLength < 126 ? 2 : (payloadLength < 65536 ? 4 : 10);
			const mask = Buffer.alloc(4);
			for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);
			mask.copy(frame, maskOffset);
			
			// Mask the payload
			for (let i = 0; i < payloadLength; i++) {
				frame[maskOffset + 4 + i] = payload[i] ^ mask[i % 4];
			}
			
			socket.write(frame);
		},
		
		close() {
			socket.destroy();
		},
	};
	
	// Handle incoming data
	socket.on("data", (chunk: Buffer) => {
		// Parse WebSocket frames
		let offset = 0;
		while (offset < chunk.length) {
			const firstByte = chunk[offset];
			const secondByte = chunk[offset + 1];
			
			const fin = (firstByte & 0x80) !== 0;
			const opcode = firstByte & 0x0f;
			const masked = (secondByte & 0x80) !== 0;
			let payloadLength = secondByte & 0x7f;
			
			let headerLength = 2;
			if (payloadLength === 126) {
				payloadLength = chunk.readUInt16BE(offset + 2);
				headerLength = 4;
			} else if (payloadLength === 127) {
				payloadLength = Number(chunk.readBigUInt64BE(offset + 2));
				headerLength = 10;
			}
			
			if (masked) headerLength += 4;
			
			const frameEnd = offset + headerLength + payloadLength;
			if (frameEnd > chunk.length) break; // Incomplete frame
			
			let payload = chunk.slice(offset + headerLength, frameEnd);
			
			if (masked) {
				const mask = chunk.slice(offset + headerLength - 4, offset + headerLength);
				for (let i = 0; i < payload.length; i++) {
					payload[i] ^= mask[i % 4];
				}
			}
			
			if (opcode === 0x01) { // Text frame
				const text = payload.toString("utf8");
				if (fin) {
					const fullMessage = dataBuffer + text;
					dataBuffer = "";
					wrapper.onmessage?.({ data: fullMessage });
				} else {
					dataBuffer += text;
				}
			} else if (opcode === 0x00) { // Continuation
				dataBuffer += payload.toString("utf8");
				if (fin) {
					wrapper.onmessage?.({ data: dataBuffer });
					dataBuffer = "";
				}
			} else if (opcode === 0x08) { // Close
				wrapper.onclose?.();
			} else if (opcode === 0x09) { // Ping
				// Send pong
				const pong = Buffer.alloc(2);
				pong[0] = 0x8a; // Pong
				pong[1] = 0x00;
				socket.write(pong);
			}
			
			offset = frameEnd;
		}
	});
	
	socket.on("close", () => {
		(wrapper as any).readyState = 3; // WebSocket.CLOSED
		wrapper.onclose?.();
	});
	
	socket.on("error", (err: any) => {
		wrapper.onerror?.(err);
	});
	
	return wrapper as unknown as WebSocket;
}

/**
 * Handle incoming AppSync message
 */
function handleMessage(
	message: AppSyncMessage,
	resolveConnection: (value: void) => void,
	rejectConnection: (reason: Error) => void,
	connectionTimeout: ReturnType<typeof setTimeout>,
): void {
	switch (message.type) {
		case "connection_ack":
			console.log("[stub] Connection acknowledged");
			clearTimeout(connectionTimeout);
			isConnected = true;
			// Subscribe to response channel after connection is established
			subscribeToResponses()
				.then(() => resolveConnection())
				.catch((err) => rejectConnection(err));
			break;

		case "ka":
			// Keep-alive ping from server
			break;

		case "subscribe_success":
			console.log("[stub] Subscribed to channel:", message.id);
			break;

		case "data":
		case "next": {
			// Response from local dev server
			// AppSync Events can deliver via events array, single event, or payload
			if (message.events && Array.isArray(message.events) && message.events.length > 0) {
				// AWS AppSync Events format: events array
				for (const eventStr of message.events) {
					try {
						const response: InvokeResponse = JSON.parse(eventStr);
						const pending = pendingRequests.get(response.requestId);
						if (pending) {
							clearTimeout(pending.timeout);
							pending.resolve(response);
							pendingRequests.delete(response.requestId);
						}
					} catch (err) {
						console.error("[stub] Failed to parse response from events array:", err);
					}
				}
			} else if (message.event) {
				// LocalStack format: single event string
				try {
					const response: InvokeResponse = JSON.parse(message.event);
					const pending = pendingRequests.get(response.requestId);
					if (pending) {
						clearTimeout(pending.timeout);
						pending.resolve(response);
						pendingRequests.delete(response.requestId);
					}
				} catch (err) {
					console.error("[stub] Failed to parse response from event:", err);
				}
			} else if (message.payload) {
				const response = message.payload as InvokeResponse;
				const pending = pendingRequests.get(response.requestId);
				if (pending) {
					clearTimeout(pending.timeout);
					pending.resolve(response);
					pendingRequests.delete(response.requestId);
				}
			}
			break;
		}

		case "subscribe_error":
			console.error("[stub] Subscribe error:", JSON.stringify(message));
			break;

		case "error":
			console.error("[stub] AppSync error:", message.payload);
			break;

		default:
			console.log("[stub] Unknown message type:", message.type);
	}
}

/**
 * Subscribe to the response channel for this lambda
 */
async function subscribeToResponses(): Promise<void> {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		throw new Error("WebSocket not connected");
	}

	// Subscribe to response channel: /elysian/response/{lambdaName}
	const channel = `/elysian/response/${config.lambdaName}`;
	const subscriptionId = `sub-${config.lambdaName}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
	console.log("[stub] Subscribing to channel:", channel, "with id:", subscriptionId);

	ws.send(
		JSON.stringify({
			type: "subscribe",
			id: subscriptionId,
			channel,
			authorization: { "x-api-key": config.apiKey },
		}),
	);
}

/**
 * Publish an invocation request to AppSync
 */
async function publishRequest(request: InvokeRequest): Promise<void> {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		throw new Error("WebSocket not connected");
	}

	// Publish to invoke channel: /elysian/invoke/{lambdaName}
	const channel = `/elysian/invoke/${config.lambdaName}`;

	ws.send(
		JSON.stringify({
			type: "publish",
			id: `pub-${Date.now()}`,
			channel,
			events: [JSON.stringify(request)],
			authorization: { "x-api-key": config.apiKey },
		}),
	);
}

/**
 * Wait for a response with timeout
 */
function waitForResponse(
	requestId: string,
	timeoutMs: number,
): Promise<InvokeResponse> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(`Request timeout after ${timeoutMs}ms`));
		}, timeoutMs);

		pendingRequests.set(requestId, { resolve, reject, timeout });
	});
}

/**
 * Main Lambda handler
 * This is the entry point for Lambda invocations in dev mode
 */
export async function handler(
	event: LambdaEvent,
	context: LambdaContext,
): Promise<LambdaResponse> {
	const requestId = generateRequestId();
	const startTime = Date.now();

	console.log(
		`[stub] Received invocation for ${config.lambdaName}:`,
		event.rawPath || event.routeKey || "unknown",
	);

	try {
		// Ensure WebSocket connection
		await connect();

		// Build the request payload
		const request: InvokeRequest = {
			requestId,
			lambdaName: config.lambdaName,
			event,
			context: {
				awsRequestId: context.awsRequestId,
				functionName: context.functionName,
				functionVersion: context.functionVersion,
				invokedFunctionArn: context.invokedFunctionArn,
				memoryLimitInMB: context.memoryLimitInMB,
				logGroupName: context.logGroupName,
				logStreamName: context.logStreamName,
			},
			timestamp: startTime,
		};

		// Calculate timeout based on remaining Lambda execution time
		// Leave 5 seconds buffer for cleanup
		const remainingTime = context.getRemainingTimeInMillis() - 5000;
		const timeoutMs = Math.max(remainingTime, 10000); // At least 10s

		// Publish request and wait for response
		await publishRequest(request);
		const response = await waitForResponse(requestId, timeoutMs);

		const duration = Date.now() - startTime;
		console.log(`[stub] Response received in ${duration}ms`);

		if (response.error) {
			console.error("[stub] Handler error:", response.error.message);
			return {
				statusCode: 500,
				body: JSON.stringify({
					error: response.error.message,
					stack: response.error.stack,
				}),
				headers: { "content-type": "application/json" },
			};
		}

		return (
			response.response || {
				statusCode: 500,
				body: JSON.stringify({ error: "No response received" }),
				headers: { "content-type": "application/json" },
			}
		);
	} catch (error) {
		console.error("[stub] Stub error:", error);
		return {
			statusCode: 502,
			body: JSON.stringify({
				error: "Live mode connection error",
				message: error instanceof Error ? error.message : String(error),
			}),
			headers: { "content-type": "application/json" },
		};
	}
}
