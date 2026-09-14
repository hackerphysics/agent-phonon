import asyncio
import json
import unittest
from types import SimpleNamespace as NS

from compat import Base, FinalItemStreamWrapper, install, handler
from litellm.types.llms.openai import ResponseAPIUsage


def item(text="hello", id="msg_1"):
    return {"id": id, "type": "message", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": text}]}


def added(i, index=0):
    return {"type": "response.output_item.added", "output_index": index, "item": i}


def done(i, index=0):
    return {"type": "response.output_item.done", "output_index": index, "item": i}


def delta(text, id="msg_1", content_index=0):
    return {"type": "response.output_text.delta", "item_id": id, "output_index": 0, "content_index": content_index, "delta": text}


def completed(items, status="completed"):
    usage = ResponseAPIUsage(input_tokens=31, output_tokens=7, total_tokens=38, input_tokens_details={"cached_tokens": 5})
    return NS(type="response.completed", response=NS(status=status, error=None, output=items, usage=usage))


class Source:
    def __init__(self, events=(), error=None, hang=False):
        self.events = iter(events)
        self.error = error
        self.hang = hang
        self.closed = False
        self.cancelled = False
    def __aiter__(self):
        return self
    async def __anext__(self):
        if self.hang:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        try:
            return next(self.events)
        except StopIteration:
            if self.error:
                raise self.error
            raise StopAsyncIteration from None
    async def aclose(self):
        self.closed = True


async def collect(source, timeout=None):
    wrapper = FinalItemStreamWrapper(source, "gpt-5.6-sol")
    if timeout:
        wrapper._deadline = __import__("time").monotonic() + timeout
    events = []
    async for blob in wrapper.async_anthropic_sse_wrapper():
        events.append(json.loads(blob.decode().split("data: ", 1)[1]))
    return events


def text(events):
    return "".join(e["delta"].get("text", "") for e in events if e["type"] == "content_block_delta")


class Regression(unittest.IsolatedAsyncioTestCase):
    def assert_error(self, events):
        self.assertEqual(events[-1]["type"], "error")
        self.assertNotIn("message_stop", [e["type"] for e in events])
    async def test_final_item_only(self):
        i = item(); s = Source([added(i), done(i), completed([i])]); events = await collect(s)
        self.assertEqual(text(events), "hello"); self.assertTrue(s.closed)
        self.assertEqual(events[-1]["type"], "message_stop")
        types = [e["type"] for e in events]
        self.assertLess(types.index("content_block_delta"), types.index("content_block_stop"))
    async def test_standard_stream_equal_to_official_adapter(self):
        i = item(); upstream = [added(i), delta("hel"), delta("lo"), done(i), completed([i])]
        expected = []
        async for blob in Base(Source(upstream), "gpt-5.6-sol").async_anthropic_sse_wrapper():
            expected.append(json.loads(blob.decode().split("data: ", 1)[1]))
        actual = await collect(Source(upstream))
        expected[0]["message"]["id"] = actual[0]["message"]["id"]
        self.assertEqual(actual, expected)
    async def test_standard_delta_not_duplicated(self):
        i = item(); events = await collect(Source([added(i), delta("hel"), delta("lo"), done(i), completed([i])]))
        self.assertEqual(text(events), "hello")
        self.assertEqual(sum(e["type"] == "content_block_delta" for e in events), 2)
    async def test_duplicate_done_not_duplicated(self):
        i = item(); events = await collect(Source([added(i), done(i), done(i), completed([i])]))
        self.assertEqual(text(events), "hello")
        self.assertEqual(sum(e["type"] == "content_block_stop" for e in events), 1)
    async def test_completed_only(self):
        events = await collect(Source([completed([item()])]))
        self.assertEqual(text(events), "hello"); self.assertEqual(events[-1]["type"], "message_stop")
    async def test_done_without_added(self):
        i = item(); events = await collect(Source([done(i), completed([i])]))
        self.assertEqual(text(events), "hello")
    async def test_two_items_order(self):
        a, b = item("A", "a"), item("B", "b")
        events = await collect(Source([added(a), done(a), added(b, 1), done(b, 1), completed([a, b])]))
        self.assertEqual(text(events), "AB")
        self.assertEqual([e["index"] for e in events if e["type"] == "content_block_delta"], [0, 1])
    async def test_multi_content_order(self):
        i = item("A"); i["content"].append({"type": "output_text", "text": "B"})
        events = await collect(Source([added(i), delta("A"), done(i), completed([i])]))
        self.assertEqual(text(events), "AB")
    async def test_delta_missing_added(self):
        i = item(); events = await collect(Source([delta("hello"), done(i), completed([i])]))
        self.assertEqual(text(events), "hello")
        self.assertEqual(sum(e["type"] == "content_block_start" for e in events), 1)
    async def test_partial_delta_rejected(self):
        i = item(); events = await collect(Source([added(i), delta("hel"), done(i), completed([i])]))
        self.assert_error(events); self.assertEqual(text(events), "hel")
    async def test_conflicting_final_rejected(self):
        i = item(); events = await collect(Source([added(i), done(i), completed([item("other")])]))
        self.assert_error(events)
    async def test_empty_final_rejected(self):
        self.assert_error(await collect(Source([completed([])])))
        self.assert_error(await collect(Source([completed([item("")])])))
    async def test_missing_completed_rejected(self):
        i = item(); self.assert_error(await collect(Source([added(i), done(i)])))
    async def test_failed_incomplete_and_error(self):
        for kind in ("response.failed", "response.incomplete", "error"):
            self.assert_error(await collect(Source([{"type": kind, "response": {"error": {"message": "original failure"}}}])))
    async def test_completed_with_bad_status(self):
        self.assert_error(await collect(Source([completed([item()], status="failed")])))
    async def test_transport_exception(self):
        s = Source(error=ConnectionError("transport")); self.assert_error(await collect(s)); self.assertTrue(s.closed)
    async def test_timeout(self):
        s = Source(hang=True); self.assert_error(await collect(s, timeout=.03)); self.assertTrue(s.closed); self.assertTrue(s.cancelled)
    async def test_cancel(self):
        s = Source(hang=True); t = asyncio.create_task(collect(s)); await asyncio.sleep(.03); t.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await t
        self.assertTrue(s.closed); self.assertTrue(s.cancelled)
    async def test_downstream_close_closes_http_response(self):
        s = Source([completed([item()])]); response = Source(); s.response = response
        w = FinalItemStreamWrapper(s, "gpt-5.6-sol"); gen = w.async_anthropic_sse_wrapper()
        await anext(gen); await gen.aclose(); self.assertTrue(s.closed); self.assertTrue(response.closed)
    async def test_tool_ids_arguments_and_stop(self):
        tool = {"type": "function_call", "id": "fc_1", "call_id": "call_original", "name": "Read", "arguments": '{"file_path":"x"}'}
        arg = {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": tool["arguments"]}
        events = await collect(Source([added(tool), arg, done(tool), completed([tool])]))
        block = next(e["content_block"] for e in events if e["type"] == "content_block_start")
        self.assertEqual(block["id"], "call_original"); self.assertEqual(block["name"], "Read")
        self.assertEqual(next(e["delta"]["partial_json"] for e in events if e["type"] == "content_block_delta"), tool["arguments"])
        self.assertEqual(events[-2]["delta"]["stop_reason"], "tool_use")
    async def test_missing_or_corrupt_tool_arguments_rejected(self):
        tool = {"type": "function_call", "id": "fc_1", "call_id": "call_original", "name": "Read", "arguments": '{"file_path":"x"}'}
        self.assert_error(await collect(Source([added(tool), done(tool), completed([tool])])))
        arg = {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{}"}
        self.assert_error(await collect(Source([added(tool), arg, done(tool), completed([tool])])))
    async def test_changed_tool_identity_rejected(self):
        tool = {"type": "function_call", "id": "fc_1", "call_id": "call_original", "name": "Read", "arguments": "{}"}
        arg = {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{}"}
        changed = {**tool, "call_id": "call_wrong"}
        self.assert_error(await collect(Source([added(tool), arg, done(changed), completed([changed])])))
    async def test_usage_preserved(self):
        i = item(); events = await collect(Source([added(i), done(i), completed([i])]))
        usage = events[-2]["usage"]
        self.assertEqual(usage["input_tokens"], 26); self.assertEqual(usage["output_tokens"], 7); self.assertEqual(usage["cache_read_input_tokens"], 5)
    async def test_unknown_content_rejected(self):
        i = item(); i["content"] = [{"type": "refusal", "refusal": "no"}]
        self.assert_error(await collect(Source([completed([i])])))
    async def test_missing_final_tool_rejected(self):
        tool = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "Read", "arguments": "{}"}
        self.assert_error(await collect(Source([completed([tool])])))
    async def test_delta_without_final_item_rejected(self):
        self.assert_error(await collect(Source([delta("hello"), completed([])])))
    async def test_earlier_missing_part_not_reordered(self):
        i = item("A"); i["content"].append({"type": "output_text", "text": "B"})
        self.assert_error(await collect(Source([added(i), delta("B", content_index=1), done(i), completed([i])])))
    async def test_nonfinal_item_rejected(self):
        i = item(); i["status"] = "in_progress"
        self.assert_error(await collect(Source([done(i), completed([i])])))
    async def test_http_error_classification(self):
        error = ConnectionError("not exposed")
        error.status_code = 429
        events = await collect(Source(error=error)); self.assert_error(events)
        self.assertEqual(events[-1]["error"]["type"], "rate_limit_error")
    async def test_live_socket_cancel_cleanup(self):
        # A local transport fixture, not another model endpoint. Uses a real HTTP
        # connection to assert cancellation closes the upstream httpx.Response.
        import httpx
        disconnected = asyncio.Event()
        async def serve(reader, writer):
            try:
                await reader.readuntil(b"\r\n\r\n")
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                await writer.drain()
                await reader.read()
            finally:
                disconnected.set(); writer.close(); await writer.wait_closed()
        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        async with server, httpx.AsyncClient(trust_env=False) as client:
            port = server.sockets[0].getsockname()[1]
            request = client.build_request("GET", f"http://127.0.0.1:{port}/fixture")
            response = await client.send(request, stream=True)
            class Wire:
                def __init__(self):
                    self.response = response; self.lines = response.aiter_lines()
                def __aiter__(self):
                    return self
                async def __anext__(self):
                    await anext(self.lines)
                    raise AssertionError("fixture emits no event")
            task = asyncio.create_task(collect(Wire()))
            await asyncio.sleep(.03); task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(response.is_closed)
            await asyncio.wait_for(disconnected.wait(), 1)
    async def test_install_version_source_guard(self):
        install(); self.assertIs(handler.AnthropicResponsesStreamWrapper, FinalItemStreamWrapper)
        install()  # Idempotent, disk remains fingerprint-identical.


if __name__ == "__main__":
    unittest.main(verbosity=2)
