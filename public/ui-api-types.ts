import type { AgentDefinition, AgentProfile, AgentRequirement, ApplicationContext, ApplicationInstance, ApplicationView, ArchitectureView, ConversationRecord, ConversationRequest, DevelopmentView, FileView, Material, Message, ReplyResult, RequestOptions, RuntimeResult, StreamOptions, TaskView, ValueSchema } from "./ui-types.js";
import type { ConnectionDefinition, ConnectionVersion } from "../src/contracts/connection.mjs";
import type { Group, GroupArtifact, GroupMention, GroupTask, MemberCard, GroupMessage } from "../src/contracts/collaboration.mjs";
import type { MainRecord, MainContext } from "../src/contracts/main.mjs";
export type { Group, GroupArtifact, GroupMention, GroupTask, MemberCard, GroupMessage, MainRecord, MainContext };
export interface AttachmentPreview { text?: string | undefined; nextOffset: number|null }
export interface ConnectionRequirement {id:string;kind:string;purpose?:string;required?:boolean;description?:string;label?:string;protocol?:string;profile?:string|undefined;sourceLabel?:string|undefined;title?:string;configFields?:{key:string;label:string;type:string;required?:boolean;placeholder?:string;options?:(string|{value:string;label:string})[]}[] }
export interface ConnectionView extends Partial<Pick<ConnectionVersion,"authType"|"provider"|"baseUrl"|"model"|"headerName"|"allowFallback"|"protocol"|"username"|"values"|"oauth"|"status">> { id: string; kind?: string | undefined; configured?: boolean | undefined; hasSecret?: boolean | undefined; authorization?: { status: string } | undefined }
export interface ConnectionSection { version: number; profile?: string | undefined; sourceLabel?: string | undefined; requirements?: ConnectionRequirement[] | undefined; connections?: ConnectionView[] | undefined }
export interface ConnectionsResult extends ConnectionSection { active?: ConnectionSection | null | undefined; candidate?: ConnectionSection | null | undefined }
export interface ConnectionResult { version?: number | undefined; connection?: ConnectionView | undefined; connections?: ConnectionView[] | undefined; authorizationUrl?: string | undefined; browserOpened?: boolean | undefined; tools?: DiscoveryItem[] | undefined; operations?: DiscoveryItem[] | undefined; resources?: DiscoveryItem[] | undefined; configurationChoices?: Record<string, { value: string; label: string }[]> | undefined; message?: string | undefined; test?: { message?: string | undefined } | undefined; ok?: boolean | undefined }
interface DiscoveryItem { title?: string | undefined; name?: string | undefined; description?: string | undefined; id?: string | undefined; uri?: string | undefined }
export interface ServiceAction { id: string; title?: string | undefined; name?: string | undefined }
export interface ServiceValueSchema extends Omit<ValueSchema, "properties" | "items"> { title?: string; properties?: Record<string, ServiceValueSchema>; items?: ServiceValueSchema }
export interface WorkflowTask { id: string; status: string; version: number; waiting: { stepId?: string | undefined; index?: number | undefined; prompt?: string | undefined; inputSchema?: ServiceValueSchema | undefined; outputSchema?: ServiceValueSchema | undefined } }
export interface ServiceEnvironment { available?: boolean | undefined; version?: string | undefined }
export interface ServiceGateway { enabled?: boolean | undefined; status?: string | undefined; deliveryVersion?: string | undefined; message?: string | undefined; actionIds?: string[] | undefined; apiUrl?: string | undefined; mcpUrl?: string | undefined }
export interface ServicesResult { deliveryVersion?: string | undefined; environment?: { docker?: ServiceEnvironment | undefined; managed?: { available?: boolean | undefined; javascript?: ServiceEnvironment | undefined; python?: ServiceEnvironment | undefined } | undefined } | undefined; service?: { language: string; host: string; status?: string | undefined; operations?: ServiceAction[] | undefined; actions?: ServiceAction[] | undefined } | null | undefined; workers?: { status: string }[] | undefined; history?: { deliveryVersion: string; active: boolean }[] | undefined; gateway?: ServiceGateway | undefined; workflowTasks?: WorkflowTask[] | undefined; actions?: ServiceAction[] | undefined }
export interface ApplicationApi {
 application(id: string): Promise<ApplicationView>;
 open(id: string): Promise<ApplicationInstance>;
 close(id: string, instanceId: string, options?: RequestOptions): Promise<unknown>;
 getState(id: string, deliveryVersion?: string): Promise<{ state: unknown; version: number }>;
 saveState(id: string, state: unknown, expectedVersion: number, deliveryVersion?: string): Promise<unknown>;
 run(id: string, actionId: string, input: unknown, mutationId: string, deliveryVersion: string, context?: ApplicationContext): Promise<unknown>;
 tasks(id: string): Promise<{ tasks: TaskView[] }>;
 task(id: string, taskId: string): Promise<{ task: TaskView }>;
 artifactPreview(id: string, taskId: string, index: number): Promise<FileView & { content: string; truncated?: boolean | undefined; integrity:{bytes:number;sha256:string;redacted?:boolean} }>;
 artifactDownloadUrl(id: string, taskId: string, index: number): string;
 downloadArtifact(id: string, taskId: string, index: number): Promise<Blob>;
 events(id: string, taskId: string, after?: number): Promise<unknown>;
 cancel(id: string, taskId: string): Promise<unknown>;
 resumeTask(id: string, taskId: string, input: unknown, expectedVersion: number, mutationId: string, resolution?: unknown): Promise<unknown>;
 services(id: string): Promise<ServicesResult>;
 prepareService(id: string, language: string, host: string): Promise<unknown>;
 startService(id: string, deliveryVersion?: string): Promise<unknown>;
 stopService(id: string, deliveryVersion?: string): Promise<unknown>;
 restartService(id: string, deliveryVersion?: string): Promise<unknown>;
 serviceLogs(id: string, deliveryVersion?: string): Promise<{ text?: string | undefined }>;
 rollbackService(id: string, deliveryVersion: string): Promise<unknown>;
 gateway(id: string): Promise<ServiceGateway>;
 configureGateway(id: string, actionIds: string[], deliveryVersion?: string): Promise<{ token?: string | undefined }>;
 revokeGateway(id: string): Promise<unknown>;
 materials(id: string): Promise<{ attachments?: Material[] | undefined; materials?: Material[] | undefined }>;
 connections(id: string): Promise<ConnectionsResult>;
 saveConnection(id: string, connection: unknown): Promise<ConnectionResult>;
 testConnection(id: string, connectionId: string, profile?: string): Promise<ConnectionResult>;
 discoverConnection(id: string, connectionId: string, specification?: unknown, profile?: string): Promise<ConnectionResult>;
 authorizeConnection(id: string, connectionId: string, profile?: string): Promise<ConnectionResult>;
 connectionAuthorization(id: string, connectionId: string, profile?: string): Promise<ConnectionResult>;
 cancelConnectionAuthorization(id: string, connectionId: string, profile?: string): Promise<ConnectionResult>;
 connectionResult(id: string, resultRef: string, offset?: number): Promise<unknown>;
 removeConnection(id: string, connectionId: string, expectedVersion: number, profile?: string): Promise<ConnectionResult>;
}
export interface AgentRuntime {
 uploadAttachment(id: string, file: File, options?: RequestOptions): Promise<{ attachment: Material }>;
 listAttachments(id: string, options?: RequestOptions): Promise<{ attachments: Material[] }>;
 getAttachment(id: string, attachmentId: string, options?: RequestOptions): Promise<{ attachment: Material }>;
 readAttachmentImage(id: string, attachmentId: string, page?: number, options?: RequestOptions): Promise<{ blob: Blob; page: number; pageCount: number | null }>;
 previewAttachment(id: string, attachmentId: string, offset?: number, options?: RequestOptions): Promise<AttachmentPreview>;
 attachmentRawUrl(id: string, attachmentId: string, download?: boolean): string;
 attachmentImageUrl(id: string, attachmentId: string, page?: number, imageId?: string): string;
 inspect(id: string): Promise<RuntimeResult>;
 listRequirements(options?: RequestOptions): Promise<{ requirements: AgentRequirement[] }>;
 saveRequirements(id: string, requirement: unknown, options?: RequestOptions): Promise<{ deleted?: boolean | undefined; requirement: AgentRequirement }>;
 getConversation(id: string, options?: RequestOptions): Promise<{ conversation: ConversationRecord | null; deleted?: boolean | undefined }>;
 saveConversation(id: string, conversation: unknown, options?: RequestOptions): Promise<{ conversation: ConversationRecord; deleted?: boolean | undefined }>;
 listConversations(id: string, options?: RequestOptions): Promise<{ conversations: (Pick<ConversationRecord, "id" | "title" | "createdAt" | "updatedAt" | "saveVersion"> & Partial<ConversationRecord>)[]; deleted?: boolean | undefined }>;
 getHistoryConversation(id: string, conversationId: string, options?: RequestOptions): Promise<{ conversation: ConversationRecord | null; deleted?: boolean | undefined }>;
 saveHistoryConversation(id: string, conversationId: string, conversation: ConversationRequest, options?: RequestOptions): Promise<{ conversation: ConversationRecord; deleted?: boolean | undefined }>;
 removeConversation(id: string, conversationId: string, options?: RequestOptions): Promise<{ deleted: boolean; id: string }>;
 listProfiles(options?: RequestOptions): Promise<{ profiles: (AgentProfile & { id: string })[] }>;
 saveProfile(id: string, profile: unknown, options?: RequestOptions): Promise<{ profile: AgentProfile; version: number }>;
 getMemory(id: string, options?: RequestOptions): Promise<{ memory: string; version?: number | undefined; updatedAt?: string | undefined }>;
 saveMemory(id: string, memory: unknown, options?: RequestOptions): Promise<{ memory: string; version?: number | undefined; updatedAt?: string | undefined }>;
 listFiles(id: string, options?: RequestOptions): Promise<{ files: FileView[]; truncated?: boolean | undefined }>;
 readFile(id: string, path: string, options?: RequestOptions): Promise<FileView & { content: string; truncated?: boolean | undefined; integrity:{bytes:number;sha256:string;redacted?:boolean} }>;
 fileDownloadUrl(id: string, path: string): string;
 downloadFile(id: string, path: string): Promise<Blob>;
 getDevelopment(id: string, options?: RequestOptions): Promise<RuntimeResult>;
 develop(id: string, options?: StreamOptions & { resume?: boolean | undefined }): Promise<ReplyResult>;
 cancelDevelopment(id: string): Promise<RuntimeResult>;
 cancelBuild(id: string): Promise<RuntimeResult>;
 build(agent: Pick<AgentRequirement, "id" | "name" | "draft">, options?: StreamOptions & { architectureRepair?: unknown }): Promise<ReplyResult>;
 turn(body: { agentId: string; sessionId: string; [key: string]: unknown }, options?: StreamOptions): Promise<ReplyResult>;
 cancel(sessionId: string): Promise<unknown>;
}
export interface GroupMessageView extends Omit<Partial<GroupMessage>, "attachments"> { content: string; role?: string | undefined; attachments?: { id: string; name?: string | undefined }[] | undefined; actions?: LinkAction[] | undefined; sources?: LinkAction[] | undefined }
export type LinkAction = string | { type?: string | undefined; href?: string | undefined; url?: string | undefined; sourceLink?: string | undefined; label?: string | undefined; name?: string | undefined };
export interface MemberView extends MemberCard { profile?: AgentProfile | undefined; task?: unknown; input?: unknown; output?: unknown; boundaries?: unknown; hardBoundaries?: unknown; capabilities?: (NonNullable<MemberCard["capabilities"]>[number] & { label?: string | undefined; description?: string | undefined; requirements?: unknown; verification?: { status: string; checkedAt?: string | undefined; description?: string | undefined } | undefined })[] | undefined }
export interface GroupView { lastSequence?: number | undefined; group: Group; members: MemberView[]; tasks: GroupTask[]; messages: GroupMessageView[]; artifacts: GroupArtifact[]; materials?: Material[] | undefined; [key: string]: unknown }
export interface SharedFile { id?: string | undefined; name?: string | undefined; path?: string | undefined; size?: number | undefined }
export interface ArtifactPreview { text?: string | undefined; content?: string | undefined; preview?: { text?: string | undefined; content?: string | undefined } | undefined; material?: Material | undefined; truncated?: boolean | undefined }
export interface ShareFilesResult { files?: SharedFile[] | undefined; attachments?: SharedFile[] | undefined; materials?: SharedFile[] | undefined; truncated?: boolean | undefined }
export interface CollaborationApi {
 groups(): Promise<{ groups: Group[] }>;
 agents(): Promise<{ agents: MemberView[] }>;
 group(id: string, options?: RequestOptions): Promise<GroupView>;
 createGroup(body: unknown): Promise<{ group: Group }>;
 updateGroup(id: string, body: unknown): Promise<{ group: Group }>;
 send(id: string, body: unknown): Promise<{ task: GroupTask; taskId?: string | undefined; message?: { id: string } | undefined }>;
 cancelTask(id: string, taskId: string): Promise<unknown>;
 removeGroupConversation(id: string, conversationId: string, body: unknown): Promise<{ removed: boolean; conversationId: string; taskIds?: string[] | undefined }>;
 events(id: string, after?: number): Promise<{ events: unknown[]; lastSequence: number }>;
 share(id: string, body: unknown): Promise<unknown>;
 upload(id: string, file: File): Promise<{ material?: Material | undefined; attachment?: Material | undefined }>;
 materialPreview(id: string, materialId: string): Promise<ArtifactPreview>;
 materialUrl(id: string, materialId: string, download?: boolean): string;
 artifact(id: string, artifactId: string): Promise<ArtifactPreview>;
 agentMaterials(id: string): Promise<ShareFilesResult>;
 agentFiles(id: string): Promise<ShareFilesResult>;
 activity(): Promise<{ [key: string]: unknown }>;
 conversations(): Promise<{ conversations: MainConversation[] }>;
 createConversation(): Promise<{ conversation: MainConversation; context?: MainPanelContext | undefined }>;
 conversation(id: string): Promise<{ conversation: MainConversation; context?: MainPanelContext | undefined }>;
 removeConversation(id: string, body: unknown): Promise<{ removed: boolean; conversationId: string }>;
 activateRequirements(id: string, body: unknown): Promise<{ conversation: MainConversation; context?: MainPanelContext | undefined }>;
 inspectAgent(id: string, options?: RequestOptions): Promise<RuntimeResult>;
 mainMaterials(id: string): Promise<{ attachments: Material[] }>;
 mainMaterialUrl(id: string, materialId: string): string;
 uploadMainMaterial(id: string, file: File): Promise<{ attachment: Material }>;
 cancelMain(id: string): Promise<unknown>;
 mainTurn(id: string, body: unknown, options?: StreamOptions): Promise<MainReplyResult>;
}
export interface GroupTaskView { id: string; conversationId?: string | undefined; goal?: string | undefined; status: string; phase?: string | undefined; createdAt?: string | undefined; updatedAt?: string | undefined; result?: string | undefined; reason?: string | undefined; participants?: { id: string; name?: string | undefined }[] | undefined; children?: { assigneeId?: string | null | undefined; status: string; title: string }[] | undefined }
export interface GroupConversationView extends GroupTaskView { taskId: string; tasks: GroupTaskView[]; order: number }
export interface MainPanelContext { type: string; agentId?: string | undefined; groupId?: string | undefined; taskId?: string | undefined; draft?: import("./ui-types.js").RequirementDraft | undefined; requirement?: AgentRequirement | undefined; confirmed?: boolean | undefined; status?: string | undefined; lastQuestion?: string | undefined; name?: string | undefined; buildStatus?: string | undefined; buildState?: { status: string; handoff?: import("./ui-types.js").RequirementHandoff | undefined; updateStatus?: import("./ui-types.js").BuildPresentation | null | undefined } | undefined }
export interface MainConversation { id: string; title: string; version: number; messages?: GroupMessageView[] | undefined; context?: MainPanelContext | null | undefined }
export interface MainUiAction { type: string; agentId?: string | undefined; requirement?: AgentRequirement | undefined }
export interface MainUiSource { type: string; groupId?: string | undefined; operation?: string | undefined }
export interface MainReplyResult extends ReplyResult { conversation?: MainConversation | undefined; context?: MainPanelContext | null | undefined; actions?: MainUiAction[] | undefined; sources?: MainUiSource[] | undefined }
