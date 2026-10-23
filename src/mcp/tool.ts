/**
 * Tool framework. Tools are declared once without transport dependencies
 * (registerTool, zod schema, readOnlyHint). The wrapper adds shared audit,
 * user context, and errors as `isError` with clear text and `retry_after`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { classifyError, GatewayError, isGatewayError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import type { Principal } from '../policy/access.js';
import type { ScopeAction } from '../policy/scopes.js';
import type { GatewayServices } from '../services/index.js';
import type { EntityRecord } from '../storage/port.js';
import type { ParsedRef } from '../services/links.js';

export interface ToolImage {
  /** base64 */
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  text: string;
  images?: ToolImage[];
  /** Audit metadata: account, chat, and number of returned messages. */
  accountId?: string | null;
  peerKey?: string | null;
  count?: number | null;
}

export interface ToolContext {
  services: GatewayServices;
  principal: Principal;
  now(): number;
  /** Resolves the requested or default account with an access check. */
  account(requested?: string): string;
  /**
   * Resolves a chat by link, username, or ID and checks user scopes.
   * `action` defaults to `read`; `write` is for tools that only
   * write to a chat without displaying its messages.
   */
  openChat(ref: string, accountId: string, action?: ScopeAction): Promise<{ parsed: ParsedRef; chat: EntityRecord }>;
}

export type ToolShape = Record<string, z.ZodTypeAny>;

export interface ToolDef<S extends ToolShape = ToolShape> {
  name: string;
  toolset: string;
  /** Always available regardless of toolset selection, so agents can inspect gateway status. */
  always?: boolean;
  title: string;
  description: string;
  input: S;
  /** Whether the tool leaves Telegram state unchanged. */
  readOnly: boolean;
  handler(args: { [K in keyof S]: z.infer<S[K]> }, context: ToolContext): Promise<ToolOutput>;
}

/** Helps TypeScript infer argument types from the schema. */
export function defineTool<S extends ToolShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Agent error text: code, explanation, and retry timing when available. */
function formatToolError(err: GatewayError): string {
  const lines = [`Error: ${err.code}`, err.message];
  if (err.retryAfter !== undefined) lines.push(`retry_after: ${err.retryAfter}`);
  if (err.outcomeUnknown) lines.push('outcome: unknown');
  return lines.join('\n');
}

/** Converts errors to GatewayError without disguising gateway bugs as Telegram errors. */
function toGatewayError(err: unknown, log: Logger, tool: string): GatewayError {
  if (isGatewayError(err)) return err;
  const looksLikeTelegram =
    typeof err === 'object' && err !== null && ('errorMessage' in err || 'seconds' in err || /[A-Z]{3,}_[A-Z_]+/.test((err as Error).message ?? ''));
  if (looksLikeTelegram || (err as Error)?.name === 'DeadlineError') return classifyError(err);
  log.error('tool failed with an internal error', { tool, error: (err as Error)?.stack ?? String(err) });
  return new GatewayError('UNAVAILABLE', `Internal gateway error in ${tool}: ${(err as Error)?.message ?? 'unknown'}. This is a bug in the gateway, not in your request.`);
}

export interface RegisterOptions {
  services: GatewayServices;
  principal: Principal;
  toolsets: string[];
  log: Logger;
  now?: () => number;
}

function createToolContext(options: RegisterOptions): ToolContext {
  const { services, principal } = options;
  const now = options.now ?? (() => Date.now());
  return {
    services,
    principal,
    now,
    account: requested => services.access.resolveAccount(principal, requested || undefined),
    openChat: async (ref, accountId, action = 'read') => {
      const found = await services.resolver.resolve(accountId, ref);
      services.scopes.assertAllowed(principal.userId, accountId, found.chat, action);
      return found;
    },
  };
}

/** Registers enabled toolsets on a per-user server. */
export function registerTools(server: McpServer, tools: ToolDef[], options: RegisterOptions): string[] {
  const context = createToolContext(options);
  const registered: string[] = [];

  for (const tool of tools) {
    if (!tool.always && !options.toolsets.includes(tool.toolset)) continue;
    registered.push(tool.name);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          // Telegram is external: the gateway cannot control response contents.
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        const startedAt = context.now();
        try {
          const output = await tool.handler(args as never, context);
          options.services.audit.record({
            userId: options.principal.userId,
            accountId: output.accountId ?? null,
            tool: tool.name,
            args,
            peerKey: output.peerKey ?? null,
            resultCount: output.count ?? null,
            startedAt,
          });
          return {
            content: [
              { type: 'text' as const, text: output.text },
              ...(output.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
            ],
          };
        } catch (err) {
          const error = toGatewayError(err, options.log, tool.name);
          options.services.audit.record({
            userId: options.principal.userId,
            accountId: typeof args.account === 'string' ? args.account : null,
            tool: tool.name,
            args,
            startedAt,
            error,
          });
          return { content: [{ type: 'text' as const, text: formatToolError(error) }], isError: true };
        }
      },
    );
  }
  return registered;
}
