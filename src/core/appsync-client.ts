/**
 * AppSync Events WebSocket Client
 *
 * Connects to AppSync Events API from the local dev server.
 * Subscribes to invoke channels and publishes responses.
 *
 * This is the local side of the Live mode bridge.
 */

import { EventEmitter } from "events";

// Types matching the stub Lambda
export interface InvokeRequest {
	requestId: string;
	lambdaName: string;
	event: LambdaEvent;
	context: Partial<LambdaContext>;
	timestamp: number;
}

export interface InvokeResponse {
	requestId: string;
	response?: LambdaResponse;
	error?: {
		message: string;
		stack?: string;
	};
	timestamp: number;
}

export interface LambdaEvent {
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

export interface LambdaContext {
	awsRequestId: string;
	functionName: string;
	functionVersion: string;
	invokedFunctionArn: string;
	memoryLimitInMB: string;
	logGroupName: string;
	logStreamName: string;
}

export interface LambdaResponse {
	statusCode: number;
	body: string;
	headers?: Record<string, string>;
	isBase64Encoded?: boolean;
}

// AppSync message types
interface AppSyncMessage {
	type: string;
	id?: string;
	channel?: string;
	events?: string[]; // AWS AppSync Events format (array)
	event?: string; // LocalStack format (single string)
	payload?: unknown;
}

export interface AppSyncClientConfig {
	httpEndpoint: string;
	realtimeEndpoint: string;
	apiKey: string;
	lambdaNames: string[];
	onInvoke: (request: InvokeRequest) => Promise<InvokeResponse>;
	onConnect?: () => void;
	onDisconnect?: () => void;
	onError?: (error: Error) => void;
}

export class AppSyncClient extends EventEmitter {
	private config: AppSyncClientConfig;
	private ws: WebSocket | null = null;
	private isConnected = false;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;
	private reconnectDelay = 1000;
	private shouldReconnect = true;
	private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
	private subscriptionIds: Map<string, string> = new Map();
	private idCounter = 0;

	constructor(config: AppSyncClientConfig) {
		super();
		this.config = config;
	}

	/**
	 * Generate a unique ID for subscriptions/publishes
	 */
	private generateId(prefix: string): string {
		return `${prefix}-${Date.now()}-${++this.idCounter}`;
	}

	/**
	 * Extract host from a URL, handling cases where scheme may be missing
	 */
	private extractHost(url: string): string {
		// If URL doesn't have a scheme, add one temporarily for parsing
		let urlToParse = url;
		if (!url.includes("://")) {
			urlToParse = `http://${url}`;
		}
		try {
			return new URL(urlToParse).host;
		} catch {
			// Fallback: try to extract host manually
			// Remove scheme if present
			const withoutScheme = url.replace(/^[a-z]+:\/\//i, "");
			// Take everything before the first / or ?
			const hostPart = withoutScheme.split(/[/?]/)[0];
			return hostPart;
		}
	}

	/**
	 * Build URL-safe base64 string without padding
	 * Required for AppSync Events WebSocket header subprotocol
	 */
	private toUrlSafeBase64(str: string): string {
		return Buffer.from(str)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	/**
	 * Build the WebSocket URL (without auth params - auth goes in subprotocol)
	 */
	private buildWebSocketUrl(): string {
		// Ensure realtime endpoint has ws:// scheme
		let realtimeUrl = this.config.realtimeEndpoint;
		if (!realtimeUrl.startsWith("ws://") && !realtimeUrl.startsWith("wss://")) {
			realtimeUrl = `ws://${realtimeUrl}`;
		}

		// Ensure the path ends with /event/realtime for Events API
		if (!realtimeUrl.includes("/event/realtime")) {
			realtimeUrl = realtimeUrl.replace(/\/?$/, "/event/realtime");
		}

		return realtimeUrl;
	}

	/**
	 * Build the WebSocket subprotocols including auth header
	 * AppSync Events expects auth as a subprotocol: header-{base64}
	 */
	private buildSubprotocols(): string[] {
		const host = this.extractHost(this.config.httpEndpoint);
		const header = JSON.stringify({
			host,
			"x-api-key": this.config.apiKey,
		});

		const headerBase64 = this.toUrlSafeBase64(header);

		return [`header-${headerBase64}`, "aws-appsync-event-ws"];
	}

	/**
	 * Connect to AppSync WebSocket
	 */
	async connect(): Promise<void> {
		if (this.isConnected) {
			return;
		}

		return new Promise((resolve, reject) => {
			const url = this.buildWebSocketUrl();
			const subprotocols = this.buildSubprotocols();

			this.ws = new WebSocket(url, subprotocols);

			const connectionTimeout = setTimeout(() => {
				if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
					this.ws.close();
					reject(new Error("Connection timeout"));
				}
			}, 15000);

			this.ws.onopen = () => {
				// Send connection_init
				this.ws!.send(JSON.stringify({ type: "connection_init" }));
			};

			this.ws.onmessage = async (event) => {
				try {
					const message: AppSyncMessage = JSON.parse(event.data as string);
					await this.handleMessage(message, resolve, reject, connectionTimeout);
				} catch {
					// Ignore parse errors - malformed messages from server
				}
			};

			this.ws.onerror = () => {
				clearTimeout(connectionTimeout);
				this.config.onError?.(new Error("WebSocket error"));
			};

			this.ws.onclose = (event) => {
				clearTimeout(connectionTimeout);
				this.isConnected = false;
				this.stopKeepAlive();
				this.config.onDisconnect?.();

				if (this.shouldReconnect) {
					this.scheduleReconnect();
				}
			};
		});
	}

	/**
	 * Handle incoming AppSync message
	 */
	private async handleMessage(
		message: AppSyncMessage,
		resolveConnection: (value: void) => void,
		rejectConnection: (reason: Error) => void,
		connectionTimeout: ReturnType<typeof setTimeout>,
	): Promise<void> {
		switch (message.type) {
			case "connection_ack":
				clearTimeout(connectionTimeout);
				this.isConnected = true;
				this.reconnectAttempts = 0;
				this.startKeepAlive();

				// Subscribe to all lambda invoke channels
				await this.subscribeToAllLambdas();
				this.config.onConnect?.();
				resolveConnection();
				break;

			case "ka":
				// Keep-alive from server
				break;

			case "subscribe_success":
				this.emit("subscribed", message.id);
				break;

			case "data":
			case "next": {
				// Incoming invoke request from stub Lambda
				if (message.events && message.events.length > 0) {
					// AWS AppSync Events format: events array
					for (const eventStr of message.events) {
						try {
							const request: InvokeRequest = JSON.parse(eventStr);
							this.handleInvokeRequest(request);
						} catch {
							// Ignore malformed invoke requests
						}
					}
				} else if (message.event) {
					// LocalStack format: single event string
					try {
						const request: InvokeRequest = JSON.parse(message.event);
						this.handleInvokeRequest(request);
					} catch {
						// Ignore malformed invoke requests
					}
				} else if (message.payload) {
					// Single payload format
					const request = message.payload as InvokeRequest;
					this.handleInvokeRequest(request);
				}
				break;
			}

			case "error":
				// Only report if there's an actual error payload
				if (message.payload) {
					this.config.onError?.(new Error(JSON.stringify(message.payload)));
				}
				break;

			case "connection_error":
				clearTimeout(connectionTimeout);
				rejectConnection(new Error(JSON.stringify(message.payload)));
				break;

			default:
				// Unknown message type
				break;
		}
	}

	/**
	 * Handle an invoke request from the stub Lambda
	 */
	private async handleInvokeRequest(request: InvokeRequest): Promise<void> {
		try {
			// Call the handler callback
			const response = await this.config.onInvoke(request);

			// Publish response back to the stub
			await this.publishResponse(request.lambdaName, response);
		} catch (error) {
			// Publish error response
			const errorResponse: InvokeResponse = {
				requestId: request.requestId,
				error: {
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				},
				timestamp: Date.now(),
			};
			await this.publishResponse(request.lambdaName, errorResponse);
		}
	}

	/**
	 * Subscribe to invoke channels for all lambdas
	 */
	private async subscribeToAllLambdas(): Promise<void> {
		for (const lambdaName of this.config.lambdaNames) {
			await this.subscribeToLambda(lambdaName);
		}
	}

	/**
	 * Subscribe to the invoke channel for a specific lambda
	 */
	async subscribeToLambda(lambdaName: string): Promise<void> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}

		const channel = `/elysian/invoke/${lambdaName}`;
		const subscriptionId = this.generateId(`sub-${lambdaName}`);

		this.subscriptionIds.set(lambdaName, subscriptionId);

		this.ws.send(
			JSON.stringify({
				type: "subscribe",
				id: subscriptionId,
				channel,
				authorization: { "x-api-key": this.config.apiKey },
			}),
		);
	}

	/**
	 * Unsubscribe from a lambda's invoke channel
	 */
	async unsubscribeFromLambda(lambdaName: string): Promise<void> {
		const subscriptionId = this.subscriptionIds.get(lambdaName);
		if (!subscriptionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}

		this.ws.send(
			JSON.stringify({
				type: "unsubscribe",
				id: subscriptionId,
			}),
		);

		this.subscriptionIds.delete(lambdaName);
	}

	/**
	 * Publish a response back to the stub Lambda
	 */
	async publishResponse(
		lambdaName: string,
		response: InvokeResponse,
	): Promise<void> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}

		const channel = `/elysian/response/${lambdaName}`;

		this.ws.send(
			JSON.stringify({
				type: "publish",
				id: this.generateId("pub"),
				channel,
				events: [JSON.stringify(response)],
				authorization: { "x-api-key": this.config.apiKey },
			}),
		);
	}

	/**
	 * Update the list of lambdas to subscribe to
	 * Used when file watcher detects new/removed lambdas
	 */
	async updateLambdas(newLambdaNames: string[]): Promise<void> {
		const currentLambdas = new Set(this.config.lambdaNames);
		const newLambdas = new Set(newLambdaNames);

		// Unsubscribe from removed lambdas
		for (const name of currentLambdas) {
			if (!newLambdas.has(name)) {
				await this.unsubscribeFromLambda(name);
			}
		}

		// Subscribe to new lambdas
		for (const name of newLambdas) {
			if (!currentLambdas.has(name)) {
				await this.subscribeToLambda(name);
			}
		}

		this.config.lambdaNames = newLambdaNames;
	}

	/**
	 * Start keep-alive pings
	 */
	private startKeepAlive(): void {
		// AppSync has a 5-minute idle timeout, ping every 2 minutes
		this.keepAliveInterval = setInterval(
			() => {
				if (this.ws && this.ws.readyState === WebSocket.OPEN) {
					this.ws.send(JSON.stringify({ type: "ka" }));
				}
			},
			2 * 60 * 1000,
		);
	}

	/**
	 * Stop keep-alive pings
	 */
	private stopKeepAlive(): void {
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval);
			this.keepAliveInterval = null;
		}
	}

	/**
	 * Schedule a reconnection attempt
	 */
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.config.onError?.(new Error("Max reconnection attempts reached"));
			return;
		}

		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;

		setTimeout(async () => {
			try {
				await this.connect();
			} catch {
				// Reconnection failed, will retry via onclose handler
			}
		}, delay);
	}

	/**
	 * Disconnect from AppSync
	 */
	disconnect(): void {
		this.shouldReconnect = false;
		this.stopKeepAlive();

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.isConnected = false;
		this.subscriptionIds.clear();
	}

	/**
	 * Check if connected
	 */
	get connected(): boolean {
		return this.isConnected;
	}
}

/**
 * Create and connect an AppSync client
 */
export async function createAppSyncClient(
	config: AppSyncClientConfig,
): Promise<AppSyncClient> {
	const client = new AppSyncClient(config);
	await client.connect();
	return client;
}
