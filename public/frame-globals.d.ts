interface NeumaFrameConfiguration { parentOrigin: string; instanceId: string; deliveryVersion: string }
interface NeumaFrameTask { taskId: string; sequence: number; deliveryVersion: string; actionId?: string; status?: string; stale?: boolean; contextRevision?: number }
interface NeumaFrameMessage { channel?: unknown; protocolVersion?: unknown; instanceId?: unknown; deliveryVersion?: unknown; type?: unknown; event?: unknown; requestId?: string; data?: NeumaFrameTask; result?: unknown; error?: { message?: string; reason?: string; status?: number } }
interface Window { __NEUMA_APPLICATION__?: NeumaFrameConfiguration }
