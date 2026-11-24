import type { CompletionRequest, CompletionResult, ModelsPort } from "@fellowship/core";

/**
 * An OpenAI-compatible endpoint on this machine. Ollama by default, and
 * unchanged against llama.cpp or LM Studio.
 *
 * A schema is passed through as constrained decoding where the server supports
 * it, and the caller validates the answer with zod regardless, because a
 * server that ignores the field fails silently otherwise.
 */

export const DEFAULT_MODEL_URL = "http://localhost:11434/v1";
export const MODEL_URL_ENV = "FELLOWSHIP_MODEL_URL";
export const MODEL_NAME_ENV = "FELLOWSHIP_MODEL";
export const EMBED_MODEL_ENV = "FELLOWSHIP_EMBED_MODEL";

const DEFAULT_MODEL = "llama3.1";
const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const TIMEOUT_MS = 120_000;

export interface ModelPortOptions {
  baseUrl?: string;
  model?: string;
  embedModel?: string;
  env?: NodeJS.ProcessEnv;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

export function createModelsPort(options: ModelPortOptions = {}): ModelsPort {
  const env = options.env ?? process.env;
  const baseUrl = (options.baseUrl ?? env[MODEL_URL_ENV] ?? DEFAULT_MODEL_URL).replace(
    /\/+$/,
    "",
  );
  const model = options.model ?? env[MODEL_NAME_ENV] ?? DEFAULT_MODEL;
  const embedModel = options.embedModel ?? env[EMBED_MODEL_ENV] ?? DEFAULT_EMBED_MODEL;

  async function post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelError(
          `The model endpoint at ${baseUrl}${path} answered ${response.status}. Is it running?`,
        );
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelError(`The model endpoint timed out after ${TIMEOUT_MS}ms.`);
      }
      if (error instanceof ModelError) throw error;
      throw new ModelError(
        `Could not reach the model endpoint at ${baseUrl}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const messages = [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ];

      const answer = (await post("/chat/completions", {
        model,
        messages,
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        // Where the server honours it, the answer cannot come back the wrong
        // shape. Where it does not, zod catches it on the way back.
        ...(request.schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: "answer", schema: request.schema, strict: true },
              },
            }
          : {}),
      })) as { choices?: Array<{ message?: { content?: string } }> };

      const text = answer.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new ModelError("The model endpoint answered without any content.");
      }
      return { text };
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const answer = (await post("/embeddings", {
        model: embedModel,
        input: texts,
      })) as { data?: Array<{ embedding?: number[] }> };

      const rows = answer.data ?? [];
      if (rows.length !== texts.length) {
        throw new ModelError(
          `Asked for ${texts.length} embeddings and got ${rows.length} back.`,
        );
      }
      return rows.map((row) => row.embedding ?? []);
    },
  };
}
