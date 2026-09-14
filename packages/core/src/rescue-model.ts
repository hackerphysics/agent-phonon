import type { LanguageModel } from "ai";
import { randomUUID } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { AnthropicLanguageModel } from "@ai-sdk/anthropic/internal";
import { createGoogle } from "@ai-sdk/google";
import { GoogleLanguageModel } from "@ai-sdk/google/internal";
import { createOpenAI } from "@ai-sdk/openai";
import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveRescueConnection, type RescueConnectionOptions } from "./rescue-config.js";

/** One transport/auth path for the CLI capability probe and runtime tool loop. */
export function createRescueModel(input: RescueConnectionOptions, model: string): LanguageModel {
  const connection = resolveRescueConnection(input);
  const endpoint = new URL(connection.baseUrl);
  const guardedFetch: typeof fetch = (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    // Prevent provider defaults from sending requests to a different origin.
    if (target.origin !== endpoint.origin || target.username || target.password) {
      throw new Error("rescue provider attempted an unexpected endpoint");
    }
    const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
    if (input.authMode === "none" && (
      ["authorization", "x-api-key", "x-goog-api-key"].some((name) => headers.has(name)) ||
      [...target.searchParams.keys()].some((name) => /key|token|authorization/i.test(name))
    )) throw new Error("rescue no-auth request contains authentication");
    return fetch(url, { ...init, redirect: "error" });
  };
  if (input.wireApi === "anthropic") {
    if (input.authMode === "none") {
      // Official, version-sensitive export: bypass the mandatory key factory.
      return new AnthropicLanguageModel(model, {
        provider: "anthropic.messages", baseURL: connection.baseUrl,
        headers: () => ({ "anthropic-version": "2023-06-01" }), fetch: guardedFetch,
      });
    }
    return createAnthropic({ baseURL: connection.baseUrl, apiKey: connection.apiKey, fetch: guardedFetch })(model);
  }
  if (input.wireApi === "gemini") {
    if (input.authMode === "none") {
      return new GoogleLanguageModel(model, {
        provider: "google.generative-ai", baseURL: connection.baseUrl,
        headers: () => ({}), fetch: guardedFetch, generateId: randomUUID,
      });
    }
    return createGoogle({ baseURL: connection.baseUrl, apiKey: connection.apiKey, fetch: guardedFetch })(model);
  }
  if (input.wireApi === "responses") {
    if (input.authMode === "none") {
      // createOpenAI() unconditionally calls loadApiKey, including OPENAI_API_KEY.
      // The official exported constructor supports headers without credentials.
      // Pin @ai-sdk/openai: its /internal export is version-sensitive.
      return new OpenAIResponsesLanguageModel(model, {
        provider: "openai.responses",
        url: ({ path }) => `${connection.baseUrl}${path}`,
        headers: () => ({}),
        fetch: guardedFetch,
      });
    }
    return createOpenAI({ baseURL: connection.baseUrl, apiKey: connection.apiKey, fetch: guardedFetch }).responses(model);
  }
  return createOpenAICompatible({
    name: "phonon-rescue", baseURL: connection.baseUrl, apiKey: connection.apiKey,
    fetch: guardedFetch, includeUsage: true,
  })(model);
}

/** Stateless Responses replay includes real function_call_output on every step. */
export function rescueProviderOptions(input: RescueConnectionOptions) {
  return input.wireApi === "responses"
    ? { openai: { store: false, parallelToolCalls: false } }
    : undefined;
}
