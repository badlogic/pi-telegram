import type {
	TelegramConfig,
	PendingTelegramTurn,
	ActiveTelegramTurn,
	TelegramPreviewState,
	TelegramMediaGroupState,
} from "./types";

export interface BridgeState {
	config: TelegramConfig;
	pollingController: AbortController | undefined;
	pollingPromise: Promise<void> | undefined;
	queuedTelegramTurns: PendingTelegramTurn[];
	activeTelegramTurn: ActiveTelegramTurn | undefined;
	typingInterval: ReturnType<typeof setInterval> | undefined;
	currentAbort: (() => void) | undefined;
	preserveQueuedTurnsAsHistory: boolean;
	setupInProgress: boolean;
	previewState: TelegramPreviewState | undefined;
	draftSupport: "unknown" | "supported" | "unsupported";
	nextDraftId: number;
	mediaGroups: Map<string, TelegramMediaGroupState>;
}

export function createState(): BridgeState {
	return {
		config: {},
		pollingController: undefined,
		pollingPromise: undefined,
		queuedTelegramTurns: [],
		activeTelegramTurn: undefined,
		typingInterval: undefined,
		currentAbort: undefined,
		preserveQueuedTurnsAsHistory: false,
		setupInProgress: false,
		previewState: undefined,
		draftSupport: "unknown" as const,
		nextDraftId: 0,
		mediaGroups: new Map(),
	};
}
