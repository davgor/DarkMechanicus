# Images in GUI agent chats: wire contract

DM-850, investigated 2026-11-27 on Windows, on top of `sprint/agent-gui-s3` at `7c637ffc`. This pins how each GUI agent CLI takes images in a user turn and returns them in tool results. The fixtures below are what `s3-imgencode` (DM-854) and `s3-imgfake` implement literally. Data and docs only: no dependency or lockfile change.

**O** means observed in the cited source, line or live output. **I** means inferred. As in `agent-chat-protocols.md`, literal ids, text and paths in fixtures are I even where the field shape is O.

## Sources

| Alias | Source | Provenance |
| --- | --- | --- |
| `SDK` | `@anthropic-ai/claude-agent-sdk@0.3.331` `sdk.d.ts`, `sdk-tools.d.ts` | The version `agent-chat-protocols.md` recorded. `npm pack` from registry.npmjs.org into OS temp only. Integrity `sha512-ml/MPqgO95tG5zcApBFxEyoDk57d9htP09R8AtPbKPUCHpsobf84IjkN4zhGvQgk8zsA9dXoeMGrQcCc8gQE/w==`, shasum `3d52acaf9e9bc44fae93b61cc05577ffba985f48`, tarball sha256 `078c236997265b960473562686d223397968425147d32e1d69b5342ae321b48a`. Peer dependency `@anthropic-ai/sdk >=0.93.0`. |
| `API` | `@anthropic-ai/sdk@1.14.0` `resources/messages/messages.d.ts` | Latest on the registry at investigation time, which satisfies the SDK peer range. `npm pack` into OS temp only. Integrity `sha512-nADYXUd5fn9Zgw2nHi1iKyt/kb1UUt1cN3RbdxEI6XjTDTxbx4LLG4GnMrxWyS9GgXQllFOyAKSiFM3joDNK9A==`, shasum `78ce155cb1fdf1cc60893d83b588d8d15dc89e0d`, tarball sha256 `5db567ee1247e8d44d028a633ea26e83733efb0c60cae6d75b36ccb489eb4a7c`. |
| `FACTS` | The OMP RPC fact sheet, the appendix of the DM-769 (`proto`) ticket ("shared footer") | Line numbers count from its `# OMP (oh-my-pi / "Skitarii") RPC …` heading as line 1. §2 is framing, §3 host→CLI commands. Second-hand observations of Ada's desktop host, as in `agent-chat-protocols.md`. |
| `OMPSRC` | OMP source at tag `v18.20.2` (`github.com/can1357/oh-my-pi`), the installed version | `packages/coding-agent/src/modes/rpc/{rpc-types.ts, rpc-mode.ts, rpc-input.ts, rpc-frame.ts, rpc-client.ts, wire/content.ts}` and `docs/rpc.md`, read through `gh api …/contents?ref=v18.20.2`. |
| `LIVE` | `%LOCALAPPDATA%/omp/omp.exe` reporting `omp/18.20.2` | Probes below, run from fresh `os.tmpdir()` folders with `--mode rpc-ui --no-session`. |
| `DM` | This repository | `src/core/attachments/intake.ts`, `src/main/agentChat/{ompProtocol,ompFraming,ompReducer,claudeProtocol}.ts`. |

## Fixture image

`src/main/agentChat/__fixtures__/images/swatch.png` is a 64x64 8-bit RGB PNG filled with pure red `#FF0000`. It has a single IDAT, deflate level 9, and no ancillary chunks, generated once with `node:zlib`; the bytes are committed, so it is never regenerated.

- Size **132 bytes**. sha256 `6f7ffeeb88929a8a2e34ea973c871f069be70cbaf1459fff345db59453934435`; the first 12 hex are `6f7ffeeb8892`.
- Base64 (176 characters): `iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC`.
- `inspectImageBytes` accepts it: `{"mime":"image/png","width":64,"height":64}`.
- The `s3-imgfake` echo for it is exactly `received image image/png 132 6f7ffeeb8892` (`received image <mime> <byte size> <first 12 hex of sha256>`).

## 1. Claude stream-json, host → CLI

The user line that carries images:

```json
{"type":"user","session_id":"session_T1","uuid":"uuid_T1_image_in","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}},{"type":"text","text":"what colour"}]}}
```

| Field | Evidence |
| --- | --- |
| `type:'user'`, `message`, `parent_tool_use_id` | O SDK `sdk.d.ts:7035-7041`: `export declare type SDKUserMessage = { type: 'user'; message: MessageParam; parent_tool_use_id: string \| null; … }`. The doc comment at 7038 reads: "a MessageParam with role "user" whose content is a string or an array of content blocks (text, image, document, tool_result, ...)". `MessageParam` comes from `@anthropic-ai/sdk/resources` (`sdk.d.ts:9`). |
| `session_id`, `uuid` envelope keys and their order | I, kept identical to S1's text encoder (`claudeProtocol.ts:578-579`), so one envelope serves text and image turns. |
| `message.role:'user'`, `message.content` array | O API `messages.d.ts:4874-4877` `UserMessageParam { content: MessageContentParam; role: 'user' }`; `:3884` `MessageContentParam = string \| Array<ContentBlockParam>`; `:3572` `ContentBlockParam = TextBlockParam \| ImageBlockParam \| …`. |
| image block `type:'image'`, `source` | O API `messages.d.ts:3671-3676` `ImageBlockParam { source: Base64ImageSource \| URLImageSource \| FileImageSource; type: 'image'; cache_control?; transformations? }`. |
| `source.type:'base64'`, `media_type`, `data` | O API `messages.d.ts:308-312` `Base64ImageSource { data: string; media_type: 'image/jpeg' \| 'image/png' \| 'image/gif' \| 'image/webp'; type: 'base64' }`. `data` is plain base64 with no `data:` prefix (I, from the field being the raw source, not a URL). |
| text block `type:'text'`, `text` | O API `messages.d.ts:4192-4196` `TextBlockParam { text: string; type: 'text'; … }`. |
| Images before text; the text block is omitted when the text is empty | I. A host convention (DM-854), which the Messages API allows in any order. Anthropic's vision guidance recommends images before the text that refers to them (I, not in these types). |
| A second image line while a turn runs | I. Same as text: Claude queues another `user` line (`agent-chat-protocols.md` "Second `user` line during an active turn"). |

`URLImageSource` (O API `:4798-4801`) and file sources are never used: DM sends only bytes it holds.

## 2. Claude, CLI → host: images in tool results

The Read tool on a PNG comes back as a `user` line whose `tool_result` block carries image content:

```json
{"type":"user",…,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_T1_read_image","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}}],"is_error":false}]},"tool_use_result":{"type":"image","file":{"base64":"<base64>","type":"image/png","originalSize":132,"dimensions":{…}}}}
```

| Field | Evidence |
| --- | --- |
| `user` line with `message.content[].type:'tool_result'`, `tool_use_id`, `is_error` | O `agent-chat-protocols.md` field inventory (CS:905-925), unchanged here. |
| `tool_result.content` as an array holding `{type:'image', source:{type:'base64', media_type, data}}` | O API `messages.d.ts:4589-4596` `ToolResultBlockParam { …; content?: string \| Array<TextBlockParam \| ImageBlockParam \| SearchResultBlockParam \| DocumentBlockParam \| ToolReferenceBlockParam \| BrowserStateBlockParam>; is_error?; }`. That the stream-json `user` echo carries the same block it sent to the model is I (`SDKUserMessage.message` is the same `MessageParam` type, O `sdk.d.ts:7040`). |
| Read returns an image for a PNG, possibly as image-only content | I for the exact content array (no live Claude run). The Read output union has an image variant, O `sdk-tools.d.ts:246-283`: `{ type: "image"; file: { base64: string; type: "image/jpeg" \| "image/png" \| "image/gif" \| "image/webp"; originalSize: number; dimensions?: { originalWidth?, originalHeight?, displayWidth?, displayHeight? } } }`. |
| `tool_use_result` on the same line | O `sdk.d.ts:7043-7046`: "Structured tool output — the tool's full Output object, not the string content sent to the model … keyed by the matching tool_use block's name". For Read on an image that Output is the variant above, so **the base64 appears twice on the line** (I for the wire, O for the types). Decoders lift images from `message.content[].content` only and never copy `tool_use_result`. |
| Resizing | I. `displayWidth/displayHeight` ("after resizing", O `sdk-tools.d.ts:273-279`) and the note at `sdk.d.ts:5206` (model-bound results are resized and "put in the Messages API's shape"; only `result_not_for_model` skips it) mean the returned block may be a resized or re-encoded copy. Its `media_type` may differ from the file's. |
| Whole or truncated | I: **whole**. No truncation field exists on image blocks or the Read image Output. Stream-json has no line limit (none declared in SDK). The model-context size check at `sdk.d.ts:5206` ("count_tokens request, … truncation, … note in place of the content") can replace an oversized result with a note; the image is then absent, never cut. |
| A failed image | O `sdk.d.ts:10705`: `TerminalReason` includes `'image_error'`. I that it arrives as an error `result`, translated by the existing error path. |

## 3. OMP rpc-ui, host → CLI

```json
{"type":"prompt","id":"req_T1_image_in","message":"what colour","images":[{"type":"image","mimeType":"image/png","data":"<base64>"}]}
```

| Field | Evidence |
| --- | --- |
| `prompt.images?: ImageContent[]`, `steer.images?` | O FACTS l.77-78 (HND:118-130, 132-140). O OMPSRC `rpc-types.ts:53-54`, `docs/rpc.md:131-132`. |
| `follow_up.images?` | O OMPSRC `rpc-types.ts:55`: `{ id?: string; type: "follow_up"; message: string; images?: ImageContent[] }`; `docs/rpc.md:133`; `rpc-mode.ts:1921-1922` `await session.followUp(text, images)`. FACTS l.79 lists only `message`; the fact sheet is older and incomplete here. `abort_and_prompt.images?` also exists (O `rpc-types.ts:59`); DM does not use it. |
| image entry `{type:'image', mimeType, data}` | O FACTS l.101-102 (IPC:1310-1319, HND:120-123): `data` is base64 with no `data:` prefix. O OMPSRC `wire/content.ts:32-41` `ImageContent { type: 'image'; data: string /* Base64-encoded image bytes */; mimeType: string; detail?; url?; providerFile? }`, "also the shape hosts send with prompts". |
| Accepted types png/jpg/jpeg/gif/webp, up to 64 MiB | O FACTS l.103 (IPC:1311, INT:417). DM sends only PNG/JPEG. |
| An image-only turn | O OMPSRC `rpc-mode.ts:1916`: `if (!text.trim() && !images?.length) return "local"`. Empty text with images is a real turn. |
| OMP re-encodes the user image | O LIVE probe 2: the 132-byte PNG came back in the `message_start`/`message_end` user echo as `{"type":"image","mimeType":"image/webp","data":"UklGRqAAAABXRUJQ…"}` (WebP), with text first and then the image. That echo is a user message, never a tool result, and decoders lift no blob from it. |
| **Chunking (`rpc_chunk`, FACTS §2) host → CLI** | **O LIVE probe 1: refused.** After `negotiate_protocol` v2 succeeded, a `get_state` split into two valid `rpc_chunk` frames was answered twice with `{"type":"response","command":"rpc_chunk","success":false,"error":"Unknown command: rpc_chunk"}`. O OMPSRC: `rpc-input.ts:44-64` parses each stdin line with `JSON.parse` and has no reassembly or size cap; `rpc-mode.ts:2905-2907` answers any other type `Unknown command: <type>`; inbound frame categories (`docs/rpc.md:104-109`) list no `rpc_chunk`; OMP's own `RpcClient` writes every command as one line (`rpc-client.ts:1788`). v2 chunking is **CLI → host only**. |
| Oversized single line | O LIVE probe 1b: a single 2 MiB line, and then a single 60 MiB line (`get_state` padded past `maxFrameBytes` 1,048,576), were both answered `success:true`. Host → CLI lines are not bound by `maxFrameBytes`. |

### Whether S1's encoder chunks outbound frames

`git grep -n "rpc_chunk" src/main/agentChat/ompProtocol.ts` prints nothing (exit 1) at `7c637ffc`. Chunking lives one module down: `encodeOmpCommand` (`ompProtocol.ts:88-97`) calls `ompWriteFrame` (`ompFraming.ts:95-107`). Any host → CLI frame longer than `state.maxFrameBytes`, or any frame given `chunkBytes`, is split into `rpc_chunk` lines when protocol v2 was negotiated; without v2 it throws `OMP chunking requires protocol v2` (`ompFraming.ts:86`). **So S1's encoder does chunk outbound frames, and OMP 18.20.2 refuses them** (probe 1). Today that path is unreachable, since text sends are at most 20,000 characters; an image prompt would reach it. The `chunked` golden pair's host half pins this refused behaviour. The contract below therefore sends image prompts unchunked.

## 4. OMP, CLI → host: images in tool results

O LIVE probe 3 (real `read` of `swatch.png` by `omp --mode rpc-ui --no-session`, base64 elided here):

```json
{"type":"tool_execution_end","toolCallId":"toolu_01Ryw…","toolName":"read","result":{"content":[{"type":"text","text":"Read image file [image/png] (displayed as image/webp)\n[Image: original 64x64, displayed at 200x200. Multiply coordinates by 0.32 to map to original image.]"},{"type":"image","data":"<224 base64 chars, UklGR…>","mimeType":"image/webp"}],"details":{"fileSize":132,"meta":{…},"mediaPath":"<absolute path>"}},"isError":false}
{"type":"message_start","message":{"role":"toolResult","toolCallId":"toolu_01Ryw…","toolName":"read","content":[<same two blocks>],"details":{…},"isError":false,"timestamp":…},"messageId":"msg-3"}
{"type":"message_end","message":{"role":"toolResult",…same…}}
{"type":"turn_end","message":{…assistant, stopReason:"toolUse"…},"toolResults":[{"role":"toolResult",…same…}]}
```

| Field | Evidence |
| --- | --- |
| `tool_execution_end.result.content[]` holding `{type:'image', data, mimeType}` | O LIVE probe 3; O shape `wire/content.ts:32-41`. Key order on the wire is `type, data, mimeType`; decoders must not depend on it. |
| `message_start`/`message_end` with `message.role:'toolResult'` and the same `content` | O LIVE probe 3. FACTS l.118 had marked "Both are emitted for user, assistant and toolResult messages" as INFERRED; it is now observed. S1's reducer already completes the tool from a toolResult `message_end` (`ompReducer.ts:78-82`) and from `turn_end.toolResults` (`:179`). |
| `turn_end.toolResults[]` carries the same message | O LIVE probe 3. The assistant message before the tool runs has `stopReason:"toolUse"` (O; was I in `agent-chat-protocols.md`). |
| **Read returns WebP, not the file's type** | O LIVE probe 3: a PNG file comes back as `image/webp`, upscaled to 200x200, with a text block naming the original type. Tool-result images may be WebP (Sprint 3 decision), so DM-854 lifts a valid WebP block as a blob and a real OMP `read` image **is shown inline**. A gif block is not lifted. |
| One image may appear up to four times per call | O: `tool_execution_end`, toolResult `message_start`, `message_end`, `turn_end.toolResults` (and `agent_end.messages`). Decoders lift blobs from **`tool_execution_end.result.content` only** (I, chosen) and treat the others as duplicates, so one call yields one blob per image block. |
| Oversized CLI → host frames | O `docs/rpc.md:60,77`: after v2 negotiation, oversized stdout objects arrive as `rpc_chunk` sequences, which S1's `ompReadFrame` reassembles. In v1, "oversized events may have strings, arrays, or object fields elided". DM always negotiates v2 when offered (`ompProtocol.ts:76`). |
| `tool_execution_update.partialResult.content` images | I: possible by type (same content shape), not observed. Decoders ignore partial results for blobs. |

## 5. Limits

O DM `intake.ts:8-9`: `MAX_IMAGE_BYTES = 10 * 1024 * 1024`, `MAX_IMAGE_SIDE = 8000`. O `inspectImageBytes` (`intake.ts:171-178`) accepts only PNG or JPEG by magic bytes, at most 10 MiB and 8000 px a side.

- **Base64 cost.** A 10 MiB image (10,485,760 bytes) is 13,981,016 base64 characters (4/3, padded): about 13.33 MiB (13.98 MB) on one line before the JSON envelope. Four images, the epic's per-send maximum, are 55,924,064 characters (about 53.3 MiB).
- **Claude.** There is no chunking in stream-json and no line limit in the SDK types (I), so the user line is written whole. Anthropic's own per-image limits (I, from public API documentation, not these types: about 5 MB per base64 image and 8000 px a side, larger images downscaled) are stricter than DM's 10 MiB. An image above them fails the turn at the provider (`image_error`, O `sdk.d.ts:10705`) rather than at DM.
- **OMP.** `maxFrameBytes` (1 MiB) bounds CLI → host frames only. Host → CLI lines above it are accepted whole (O probe 1b, to 60 MiB) and `rpc_chunk` is refused (O probe 1). The only host-side ceiling is the advertised `maxReassembledFrameBytes` (64 MiB, O ready frame), which DM's limits keep every send under (53.3 MiB at four 10 MiB images).
- **Which limit wins.** DM's intake (PNG/JPEG, 10 MiB, 8000 px) is applied before any encoder, and it is the binding host-side limit for both CLIs. Claude's provider may refuse a smaller image, and OMP re-encodes images itself (O probes 2 and 3).

## 6. Optional live probes (evidence only)

1. **OMP inbound chunking:** refused as quoted above (`Unknown command: rpc_chunk`). An unchunked `get_state` sent right after was answered normally. 1b: single-line commands of 2 MiB and 60 MiB were answered `success:true`. No model turn.
2. **OMP image turn:** `omp --mode rpc-ui --no-session --no-tools`; after `negotiate_protocol` v2, `{"type":"prompt","id":"probe_prompt","message":"Name the colour of this image in one word","images":[{"type":"image","mimeType":"image/png","data":"<swatch.png base64>"}]}` was admitted (`{"id":"probe_prompt","type":"response","command":"prompt","success":true}`). The assistant answered **`Red`** with `stopReason:"stop"` (model `claude-opus-5-5`, provider `anthropic`), then `prompt_result` `status:"completed"`. Exit 0.
3. **OMP image tool result:** `omp --mode rpc-ui --no-session`, with `swatch.png` copied into the temp cwd. The prompt asked the agent to read it. The frames are quoted in §4. Exit 0.
4. **Claude:** not run. `where.exe claude` printed `INFO: Could not find files for the given pattern(s).`, and `spawnSync('claude', ['-p','--input-format','stream-json','--output-format','stream-json','--verbose'])` failed `Error: spawnSync claude ENOENT`. Claude is not installed on this host. The help-only binary the orchestrator extracted for DM-769 was not used: it is not an install and was provisioned for `--help` only. Claude fields above stay O from types or I.

The probes ran with the person's existing OMP sign-in, from fresh temp folders with `--no-session`, so no session file was written. No credentials were entered and no personal images were used.

## Fixtures

Root `src/main/agentChat/__fixtures__/`. They use the S1 `proto` rules: one turn per file, every id contains `T1`, no timestamps, LF (`.gitattributes` covers `__fixtures__/**/*.jsonl`).

| Pair | Host line(s) | CLI lines |
| --- | --- | --- |
| `claude/image_in` | One `user` line: image block (swatch.png) then text `what colour` (§1). | Streamed text and the `assistant` message `received image image/png 132 6f7ffeeb8892`, then a success `result` with the same text. |
| `claude/image_result` | `user` text `Read swatch.png`. | A Read `tool_use` with `file_path`, then a `user` `tool_result` whose `content` is `[image block]`, with the `tool_use_result` Read image Output beside it (§2), then the answer `Red` and `result`. |
| `omp/image_in` | `prompt` with `images:[{type:'image',mimeType:'image/png',data}]` and message `what colour` (§3). | `response`; `agent_start`; `turn_start`; the user echo `message_start`/`message_end` (text, then the image); the echo reply streamed and ended; `turn_end`; `agent_end`; `prompt_result`. |
| `omp/image_result` | `prompt` `Read swatch.png`. | User echo; a `read` toolCall stream with `stopReason:"toolUse"`; `tool_execution_start`; `tool_execution_end` with `result.content:[text, image]`; the toolResult `message_start`/`message_end`; `turn_end` with `toolResults`; a second turn answering `Red`; `agent_end`; `prompt_result`. |

The fixtures depart from the live observations in two inferred places:
- The tool results carry `swatch.png` itself as `image/png`, so DM-854 can assert that one blob decodes to its exact bytes. Real OMP 18.20.2 returns WebP (§4), and real Claude may return a resized copy (§2).
- The OMP user echo repeats the sent PNG. Real OMP echoes its WebP re-encoding (probe 2).

The `claudeProtocol.test.ts` and `ompProtocol.test.ts` catalog assertions list the new pairs beside `worker_approval`/`worker_claim`: they are pinned here, and DM-854 adds their translation expectations. `fakeAgentCli.test.ts` replays each new `.out` golden byte for byte through its existing generic scenario loop.

## Consequences for later tickets

- **DM-854 OMP size test.** Its test reads "omp: an image larger than the fixture's `maxFrameBytes` is chunked or refused, as decided". Under this decision it becomes: an image prompt larger than `maxFrameBytes` is written as **one unchunked line**, and a line above `maxReassembledFrameBytes` throws `image_too_large`. Neither choice the ticket offered works. Chunks are refused by OMP. Refusing above 1 MiB would block ordinary screenshots: base64 inflates a 768 KiB PNG past it.
- **WebP tool results.** Real OMP `read` results are WebP (§4), and Claude's Read may re-encode too (§2). Per the Sprint 3 decision, result blobs may be WebP (decode side only; intake for person uploads stays PNG/JPEG), so DM-854 lifts PNG, JPEG and WebP tool-result images; other types such as gif show as `1 image (<mime>, not shown)`.
- **S1 outbound chunking.** `ompWriteFrame`'s host → CLI chunking, and the host half of the `chunked` golden pair, pin a behaviour OMP 18.20.2 refuses (§3).

## Image contract

| | Claude (`--input-format stream-json`) | OMP (`--mode rpc-ui`) |
| --- | --- | --- |
| **Encoder shape** | One `user` line, envelope `{type:'user', [session_id], uuid, parent_tool_use_id:null, message:{role:'user', content:[…images, text?]}}`. Each image is `{type:'image', source:{type:'base64', media_type:<'image/png'\|'image/jpeg'>, data:<base64>}}`. Images come first; the `{type:'text', text}` block is last and is omitted when the text is empty. A turn while busy is another `user` line. Pinned by `claude/image_in.in.jsonl`. | `{type:'prompt', id, message:<text>, images:[{type:'image', mimeType:<'image/png'\|'image/jpeg'>, data:<base64>}]}`. While a turn runs, use `follow_up` with the same `images`. The `message` key is always present (possibly `""`). Pinned by `omp/image_in.in.jsonl`. |
| **Decoder path to image blocks** | A `user` line → `message.content[]` where `type === 'tool_result'` → `content` when it is an array → each block with `type === 'image'` and `source.type === 'base64'`. Use `source.media_type` and `source.data`, keyed by `tool_use_id`. Ignore `tool_use_result` and string `content`. Forwarded subagent results (`parent_tool_use_id` set) follow the same path with their thread. | `tool_execution_end.result.content[]` → each block with `type === 'image'`; use `mimeType` and `data`, keyed by `toolCallId`. ToolResult `message_start`/`message_end`, `turn_end.toolResults`, `agent_end.messages` and user echoes are duplicates or user turns: **no blob** from them. `rpc_chunk` reassembly (S1) happens before decoding. |
| **Blob rule (both)** | Only `image/png`, `image/jpeg` or `image/webp` blocks whose bytes match the declared type and pass `inspectToolImageBytes` (`inspectImageBytes` plus WebP, same 10 MiB and 8000 px limits) become a blob, at most 8 per item. Any other type, or bytes it refuses, becomes the `resultSummary` note `1 image (<mime>, not shown)`. Base64 never enters an item, event or summary. | Same. Real OMP `read` returns `image/webp` (§4), which this rule lifts as a blob. |
| **Size rule** | No chunking exists, and the line is written whole. The encoder adds no limit of its own beyond intake; DM refuses at intake (`inspectImageBytes`: 10 MiB, 8000 px, PNG/JPEG). A provider refusal surfaces as the turn's error result. | **Never `rpc_chunk` host → CLI** (refused by OMP 18.20.2, probe 1): the encoder writes the prompt or follow_up as one line regardless of `maxFrameBytes`, bypassing `ompWriteFrame`'s chunking. Throw `{code:'image_too_large'}` only when the encoded line's UTF-8 byte length exceeds the ready frame's `maxReassembledFrameBytes` (64 MiB). DM intake makes that unreachable for four 10 MiB images (53.3 MiB), so it is a guard, not a user path. |
| **Which DM limit wins** | DM intake (10 MiB, 8000 px, PNG/JPEG) on the host side. The provider's stricter per-image limit (I, about 5 MB) can still fail a turn. | DM intake (10 MiB, 8000 px, PNG/JPEG); OMP's 64 MiB is never binding. OMP may re-encode (WebP) before the model. |
