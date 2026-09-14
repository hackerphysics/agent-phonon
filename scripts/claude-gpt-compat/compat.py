"""Narrow process-local LiteLLM 1.100.0 Responses->Messages compatibility shim.
No HTTP protocol implementation: the pinned official adapter still converts all events.
Only finalized output_text with NO deltas is replayed, immediately before item.done.
"""
import asyncio
import hashlib
import importlib.metadata
import inspect
import json
import os
import time
from pathlib import Path

from litellm.llms.anthropic.experimental_pass_through.responses_adapters import handler
from litellm.llms.anthropic.experimental_pass_through.responses_adapters import streaming_iterator

Base = streaming_iterator.AnthropicResponsesStreamWrapper
PINS = {
    streaming_iterator: "75fcf0dfb4b458b2dc8d96dcbda4e9b2afd41ad2a1dc6761c870816793bb9a42",
    handler: "1f604cf5910e53f9c90d5f6cd764a7564ba4a325d2c1ce27de1b94725e5fbd27",
}


def get(obj, key, default=None):
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


def audit(kind, **data):
    # Disabled by default. Acceptance uses only isolated, nonsecret prompts/tools.
    dest = os.environ.get("PHONON_COMPAT_AUDIT")
    if dest:
        with open(dest, "a", encoding="utf-8") as f:
            f.write(json.dumps({"time": time.time(), "kind": kind, **data}, ensure_ascii=False) + "\n")


class CompatibilityError(RuntimeError):
    pass


class FinalItemStreamWrapper(Base):
    timeout_seconds = 45

    def __init__(self, responses_stream, model):
        super().__init__(responses_stream, model)
        self._source = responses_stream.__aiter__()
        self._added = set()
        self._done = {}
        self._deltas = {}
        self._tools = {}
        self._tool_arguments = {}
        self._terminal = False
        self._visible = False
        self._closed = False
        self._deadline = time.monotonic() + self.timeout_seconds

    def _finish_text(self, item, output_index):
        item_id = get(item, "id")
        if not isinstance(item_id, str) or not item_id:
            raise CompatibilityError("Final message item has no ID")
        if get(item, "status") != "completed":
            raise CompatibilityError("Message item is not finalized")
        content = get(item, "content", [])
        # Do not flatten unknown/refusal/media into invented plain text.
        if any(get(part, "type") != "output_text" for part in content):
            raise CompatibilityError("Unsupported final message content; not converted to text")
        texts = [get(part, "text") for part in content]
        if any(not isinstance(text, str) for text in texts):
            raise CompatibilityError("Invalid final text")
        if item_id in self._done:
            if self._done[item_id] != texts:
                raise CompatibilityError("Conflicting repeated final item")
            return False
        if item_id not in self._added and item_id not in self._item_id_to_block_index:
            super()._process_event({"type": "response.output_item.added", "output_index": output_index, "item": item})
        self._added.add(item_id)
        for index, text in enumerate(texts):
            key = (item_id, index)
            seen = self._deltas.get(key)
            if seen is not None:
                # Even partial delta streams must not silently lose or duplicate text.
                if seen != text:
                    raise CompatibilityError("Text delta/final mismatch; refusing partial repair")
            elif text:
                if any(k[0] == item_id and k[1] > index for k in self._deltas):
                    raise CompatibilityError("Missing earlier content would reorder streamed text")
                event = {"type": "response.output_text.delta", "item_id": item_id,
                         "output_index": output_index, "content_index": index, "delta": text}
                super()._process_event(event)
                audit("normalized_text", message_id=self._message_id, item_id=item_id,
                      output_index=output_index, content_index=index, text=text,
                      reason="final_item_without_delta")
            self._visible = self._visible or bool(text)
        if any(key[0] == item_id and key[1] >= len(texts) for key in self._deltas):
            raise CompatibilityError("Text delta has no matching final content")
        self._done[item_id] = texts
        return True

    def _validate_tool(self, item):
        item_id = get(item, "id")
        identity = (get(item, "call_id"), get(item, "name"))
        if self._tools.get(item_id) != identity or not all(identity):
            raise CompatibilityError("Tool identity changed or missing streamed tool start")
        if self._tool_arguments.get(item_id, "") != get(item, "arguments"):
            raise CompatibilityError("Tool argument delta/final mismatch; no tool data repair")

    def _process_event(self, event):
        kind = get(event, "type")
        serial = event.model_dump(mode="json") if hasattr(event, "model_dump") else event
        audit("upstream_event", message_id=self._message_id, event=serial)
        if self._terminal:
            raise CompatibilityError("Event after terminal response")
        if kind in ("error", "response.failed", "response.incomplete"):
            # Never let the stock wrapper turn failed/incomplete into end_turn.
            audit("upstream_failure", message_id=self._message_id, event=serial)
            raise CompatibilityError("Upstream " + kind + "; no successful completion")
        if kind == "response.output_item.added":
            item = get(event, "item")
            item_id = get(item, "id")
            if get(item, "type") == "function_call":
                self._tools[item_id] = (get(item, "call_id"), get(item, "name"))
            if item_id in self._added:
                raise CompatibilityError("Repeated output_item.added")
            self._added.add(item_id)
        elif kind == "response.output_text.delta":
            item_id = get(event, "item_id")
            index = get(event, "content_index", 0)
            delta = get(event, "delta")
            if not item_id or not isinstance(index, int) or index < 0 or not isinstance(delta, str):
                raise CompatibilityError("Invalid text delta identity")
            if item_id in self._done:
                raise CompatibilityError("Text delta after item.done")
            if any(k[0] == item_id and k[1] > index for k in self._deltas):
                raise CompatibilityError("Out-of-order text content index")
            key = (item_id, index)
            self._deltas[key] = self._deltas.get(key, "") + delta
            self._visible = self._visible or bool(delta)
        elif kind == "response.function_call_arguments.delta":
            item_id = get(event, "item_id")
            delta = get(event, "delta")
            if item_id not in self._tools or not isinstance(delta, str):
                raise CompatibilityError("Tool argument delta has no known identity")
            self._tool_arguments[item_id] = self._tool_arguments.get(item_id, "") + delta
        elif kind == "response.output_item.done":
            item = get(event, "item")
            if get(item, "type") == "function_call":
                self._validate_tool(item)
            if get(item, "type") == "message":
                if not self._finish_text(item, get(event, "output_index")):
                    return  # duplicate identical done: no double close or text
        elif kind == "response.completed":
            response = get(event, "response")
            if get(response, "status") != "completed" or get(response, "error"):
                raise CompatibilityError("Invalid successful response status")
            output = get(response, "output", [])
            final_ids = set()
            for index, item in enumerate(output):
                item_id = get(item, "id")
                if item_id in final_ids:
                    raise CompatibilityError("Duplicate final output ID")
                final_ids.add(item_id)
                if get(item, "type") == "message":
                    if self._finish_text(item, index):
                        super()._process_event({"type": "response.output_item.done", "output_index": index, "item": item})
                elif get(item, "type") == "function_call":
                    # Tool events/IDs/arguments are entirely owned by LiteLLM.
                    self._validate_tool(item)
                    self._visible = True
            observed_ids = self._added | set(self._done) | {k[0] for k in self._deltas}
            if not self._visible or not observed_ids.issubset(final_ids):
                raise CompatibilityError("Missing final output; refusing empty success")
            self._terminal = True
        super()._process_event(event)

    async def __anext__(self):
        if self._chunk_queue:
            return self._chunk_queue.popleft()
        if self._terminal:
            raise StopAsyncIteration
        if not self._sent_message_start:
            self._sent_message_start = True
            return self._make_message_start()
        while True:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Responses stream deadline exceeded")
            try:
                event = await asyncio.wait_for(anext(self._source), remaining)
            except StopAsyncIteration:
                raise CompatibilityError("Upstream ended without response.completed") from None
            # Unlike the stock wrapper, exceptions propagate to the SSE error boundary.
            self._process_event(event)
            if self._chunk_queue:
                return self._chunk_queue.popleft()

    async def aclose(self):
        if self._closed:
            return
        self._closed = True
        # Pinned LiteLLM Responses iterator owns an httpx.Response, but has no aclose.
        # Custom/fake async sources may implement aclose themselves.
        objects = [self._source, self.responses_stream, getattr(self.responses_stream, "response", None)]
        seen = set()
        for obj in objects:
            if obj is not None and id(obj) not in seen:
                seen.add(id(obj))
                close = getattr(obj, "aclose", None)
                if close:
                    await close()
        audit("stream_closed", message_id=self._message_id, completed=self._terminal)

    async def async_anthropic_sse_wrapper(self):
        try:
            async for chunk in self:
                yield ("event: " + chunk["type"] + "\ndata: " + json.dumps(chunk) + "\n\n").encode()
        except Exception as exc:
            self._chunk_queue.clear()
            # Error remains an Anthropic error, NOT message_stop/end_turn. Avoid reflecting
            # arbitrary transport exception text (URLs/headers) into client-visible logs.
            audit("stream_error", message_id=self._message_id, error_class=type(exc).__name__)
            status = getattr(exc, "status_code", None)
            error_type = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
                          429: "rate_limit_error", 529: "overloaded_error"}.get(status, "api_error")
            chunk = {"type": "error", "error": {"type": error_type, "message": "Local Responses stream failed: " + type(exc).__name__}}
            yield ("event: error\ndata: " + json.dumps(chunk) + "\n\n").encode()
        finally:
            await self.aclose()


def install():
    if importlib.metadata.version("litellm") != "1.100.0":
        raise RuntimeError("Unsupported LiteLLM version; rerun compatibility review")
    for module, expected in PINS.items():
        if hashlib.sha256(Path(inspect.getfile(module)).read_bytes()).hexdigest() != expected:
            raise RuntimeError("LiteLLM source fingerprint mismatch")
    # Only this launcher's in-memory binding, no site-packages writes, no global install.
    if handler.AnthropicResponsesStreamWrapper not in (Base, FinalItemStreamWrapper):
        raise RuntimeError("Unexpected adapter binding")
    handler.AnthropicResponsesStreamWrapper = FinalItemStreamWrapper
