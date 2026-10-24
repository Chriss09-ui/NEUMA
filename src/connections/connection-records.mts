import { Ajv } from "ajv";
import type { ConnectionRoot, OAuthConfiguration } from "../contracts/connection.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";

const string = { type: "string" }, number = { type: "number" }, boolean = { type: "boolean" };
const array = (items: ToolSchema): ToolSchema => ({ type: "array", items });
const object = (properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema => ({ type: "object", properties, required, additionalProperties: true });
const dictionary = (value: ToolSchema): ToolSchema => ({ type: "object", additionalProperties: value });
const nullable = (value: ToolSchema): ToolSchema => ({ anyOf: [value, { type: "null" }] });
const strings = array(string), rawObject = object({});
const tokens = object({ accessToken: string, refreshToken: string, expiresAt: nullable(number), scopes: strings }, ["accessToken", "expiresAt", "scopes"]);
const oauth = object({ issuer: string, authorizationUrl: string, tokenUrl: string, clientId: string, clientSecret: string,
  scopes: strings, resource: string, registrationUrl: string, issuerParameterSupported: boolean });
const mapping = { anyOf: [string, object({ from: string, config: string, credential: string, literal: {} })] };
const request = object({ path: dictionary(mapping), query: dictionary(mapping), headers: dictionary(mapping), body: dictionary(mapping), bodyFrom: string, encoding: string });
const operation = object({ id: string, description: string, method: string, path: string, input: string, output: string,
  safeTest: boolean, readOnly: boolean, testInput: rawObject, inputSchema: rawObject, outputSchema: rawObject,
  tool: string, resourceUri: string, timeoutMs: number, request }, ["id"]);
const discovery = object({ tools: array(object({ name: string, title: string, description: string, inputSchema: rawObject,
  outputSchema: rawObject, annotations: rawObject, contractHash: string }, ["name", "inputSchema", "contractHash"])),
  resources: array(object({ uri: string, name: string, description: string, mimeType: string, contractHash: string }, ["uri", "name", "contractHash"])),
  operations: array(operation), requiresReview: boolean });
const version = object({ id: string, kind: string, authType: string, version: number, generation: string, grantEpoch: number,
  provider: string, baseUrl: string, model: string, headerName: string, allowFallback: boolean, protocol: string, username: string,
  values: rawObject, secret: string, secretValues: dictionary(string), tokens, oauth, status: string, updatedAt: string,
  testedAt: nullable(string), reason: nullable(string), credentialRef: string, discovery, pendingDiscovery: discovery,
  discoveryRequirementHash: string, configurationChoices: dictionary(array(object({ value: string, label: string }, ["value", "label"]))) },
  ["id", "kind", "authType", "version", "generation"]);
const entry = object({ id: string, generation: string, currentVersion: number, grantEpoch: number, versions: dictionary(version) },
  ["id", "generation", "currentVersion", "versions"]);
const section = object({ schemaVersion: { const: 1 }, agentId: string, version: number, connections: dictionary(entry) },
  ["schemaVersion", "agentId", "version", "connections"]);
const root = { ...section, properties: { ...section.properties, activeProfile: string, profiles: dictionary(section), revokedGenerations: dictionary(boolean) } };
const ajv = new Ajv({ strict: false, allErrors: false });
export const isConnectionRoot = ajv.compile<ConnectionRoot>(root);
export const isConnectionOAuth = ajv.compile<OAuthConfiguration>(oauth);
