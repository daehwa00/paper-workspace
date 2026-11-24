# Rebuttal implementation contract

The project slug is the URL identifier; resolve it to the manifest backup ID on
the server. Domain metadata is authoritative in the rebuttal SQLite service.
Response text is authoritative in the existing project Yjs room, in the
`rebuttalResponses` map, never in the manuscript `files` map. The collaboration
service mirrors registered responses to `rebuttal/responses/{text_key}.md` inside
the mounted project source directory. It never writes manuscript files for this
feature. Reviews, review translations and other domain metadata remain authoritative in
the SQLite service and must be changed through its revision-checked API. Korean
response text and translation metadata are shared in Yjs; a restored document's
immutable `korean_seed:{text,meta}` is initialization provenance only.

## Response synchronization

Clients allocate missing response text types with authenticated POST
`/collab-runtime/{encoded_room}?response-init=1`, using
`{entries:[{key,initial}],state_vector?:base64}`. The server serializes allocation,
retains any existing text (including an intentionally empty response), and returns
`{initialized:true,update:base64}`. Clients apply the Yjs update before enabling
the editor. They must never create competing `Y.Text` map values themselves.
Existing response Markdown files take precedence over initial seeds. Restore
allocates cloned IDs with the same protocol and cannot overwrite edits made by
another browser that already opened the restored round.

Restore publishes English and Korean initialization seeds together with the new
document IDs. Every current client initializes those same values, retaining an
existing shared text even when it is empty. Korean seed metadata is copied only
when no shared metadata exists and the shared Korean text still equals the seed.
Seed fields are immutable through round edits and are never fallback export or
backup content. Existing tabs must reload after deploying this protocol update.

The collaboration service watches registered responses while the room is open,
and reconciles them again after persistence loads on reconnection. It stores a
common text and Yjs snapshot under `rebuttal/.sync/`. Independent web/server edits
are merged; overlapping edits or an unavailable baseline preserve both originals
under `rebuttal/conflicts/` before displaying the server version. The shared
`rebuttalSourceStatus` map reports file paths and `synced`, `conflict`, `missing`
or `error`. Conflict notices remain visible across reloads. Missing files never
delete the shared response. Unsafe paths, symlinks, unreadable/oversized files and
document quota failures preserve the existing content and report an error.
Baseline version 1 also accepts an optional bounded `history` of prior common
texts. Late server saves use this history; ambiguous bases preserve both copies.
Every server import that changes shared text first durably preserves the previous
web text under `rebuttal/.sync/history/`, with its path in `recoveryPath`.

Metadata forms retain the round snapshot from when the form opened. Before a
round PUT, the client merges only the author's changed fields into current state;
items with stable IDs are merged individually. An overlapping field change is
blocked with the form intact. Polling and a 409 refresh never replace this edit
baseline, so retrying cannot turn an old form into an unconditional overwrite.

## HTTP contract

Base: `/api/rebuttal/projects/{slug}`. JSON requests and responses. Mutations
include `expected_revision` (project revision); mismatches return 409 with the
current revision. State responses are `{schema_version:1, revision, rounds:[],
jobs:[], enabled:true}`. A mutation returns the updated state, with additional
`result` where useful. All identifiers are opaque safe strings.

- GET `/state`: full project metadata (ETag supported).
- POST `/rounds`: `{title, expected_revision}` creates an empty round.
- PUT `/rounds/{id}`: `{round, expected_revision}` updates editable metadata.
- POST `/rounds/{id}/documents`: `{title, reviewer_id:null|string, kind:reviewer|common|unified, expected_revision}`.
- POST `/rounds/{id}/imports`: `{kind:text|json|pdf|openreview, text?, filename?, data_base64?, forum?, connection_id?, api_version?:1|2, expected_revision}` creates a staged import and returns `result.import` with editable `reviews` and `pages`.
- POST `/rounds/{id}/imports/{import_id}/reparse`: `{expected_revision}` deterministically refreshes a pending PDF/text proposal from immutable source; never changes committed reviews or calls an LLM. Returns `result.import`.
- POST `/rounds/{id}/imports/{import_id}/commit`: `{reviews, expected_revision}`. Preserve raw source, commit edited extraction as a revision; never remove unreturned OpenReview notes.
- POST `/openreview/session`: `{username,password,api_version?:2}`; MFA returns `result` with challenge ID and methods. POST `/openreview/session/mfa`: `{challenge_id,method,code}`; DELETE `/openreview/session` disconnects. Connections are bound to an opaque HttpOnly session cookie and authenticated actor, memory-only, at most one hour. Never return the OpenReview token.
- POST `/rounds/{id}/rules`: `{rules, expected_revision}` adds a draft version. POST `/rounds/{id}/rules/{rule_id}/apply`: `{expected_revision}` explicitly applies it.
- POST `/rounds/{id}/analyses`: `{task:analyze|translate|translate_response|map|connect|style|consistency|simulate|rewrite|research_rules, texts:{document_id:text}, scope?:{review_ids?,document_ids?,concern_ids?}, selection?, profile?, expected_revision}` queues a snapshot. Review/connection analyses are explicit actions; opening or refreshing an outdated Korean response view may queue `translate_response`.
- GET `/rounds/{id}/analyses/{job_id}` returns `{job}` for progress, including completed translation blocks while running.
- POST `/rounds/{id}/analyses/{job_id}/cancel` or `/retry`.
- POST `/rounds/{id}/exports`: `{format:txt|markdown|json|zip|pdf|source, texts, target?:{document_ids, title?,format?,common_mode?}, template?:{files,entrypoint}, expected_revision}`. Text/JSON exports return `result` containing `filename,content,mime`; binary exports return `data_base64,mime,filename`; also `checks` and `text`.
- POST `/rounds/{id}/submissions`: same assembly input; freeze only if applicable mechanical constraints pass. No secrets or internal analysis in submission output.
- GET `/snapshot`: metadata for backup. POST `/restore`: `{snapshot,expected_revision}` clones restored rounds and remaps IDs; returns cloned documents' seed texts under `result.texts`.

Each round has `id,title,reviewers:[],reviews:[],imports:[],documents:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}`. Reviews: `id,reviewer_id,fields:{field:text},translations:{field:text},source_id,note_id?,source_version?`. Documents: `id,title,kind,reviewer_id,text_key,seed_text` (seed only; use live Yjs text thereafter). Concerns: `id,title,reviewer_id,source_spans:[],requires_response:true,parent_id?,group?,strategy:clarify|accept|dispute|scope,work_status:todo|review|confirmed,assignee?,priority?,comments:[]`. Mappings: `id,concern_id,response_spans:[],coverage:addressed|partial|related|missing|uncertain,reason,missing:[],origin:manual|ai,decision:proposed|confirmed|rejected,input_hash?`. A source span has `review_id,field,quote,start?,end?`; a response span has `document_id,quote,start,end,content_hash?,anchorRelative?,headRelative?`. All offsets are UTF-16 units, derived and verified from exact quotes, never trusted from the model. Multiple spans are allowed on both sides. Findings: `id,document_id,type,quote,reason,suggestion,meaning_change,status,input_hash?`.

Rules draft: `id?,venue,year,track,stage,layout:per_reviewer|unified|threads,allow_common:true|false,limits:[],policies:{},deadline?:{at,timezone},sources:[],notes?`. Each limit: `id?,scope:document|total|target,document_id?,unit:characters|words|pages,max,count_spaces:true,count_newlines:true,basis:raw|rendered,character_mode:codepoints|utf16,include_headings:true,include_quotes:true,include_math:true,include_references:true`. Rule sources: `url?,title?,excerpt?,checked_at?,status?:verified|unverified|conflict`. Applied rules are immutable copies with actor/time. Default limits are unset, not 2500. Rule candidates never become active through LLM output.

## Internal bridge and compiler contracts

The Python service calls POST `http://codex-bridge:8790/internal/rebuttal`
with bearer CODEX_BRIDGE_TOKEN and `{task,payload,profile?,job_id}`. Response
`{result: <validated task JSON>}`. POST `/internal/rebuttal/cancel` with
`{job_id}` cancels only that job. The existing `/api/codex` contract is retained.
Only `research_rules` enables live web search; all other tasks explicitly disable
it. Research payload contains only venue/year/track/stage/official URLs.

Compiler POST `/extract-review`: `{data_base64}` returns `{pages:[{page,text}],text}`.
Compiler POST `/rebuttal-render`: `{documents:[{id,title,text}],template?:{files,entrypoint},assets?:{}}`
returns `{pdf:<base64>, page_count, files:{path:text}, warnings:[]}`. No manuscript
cache/activity mutation. Pandoc and pdflatex execute in a bounded networkless
temporary directory; no shell, Lua filters or arbitrary external files.

Analysis `payload` includes `{reviews,concerns,documents:[{id,text}],glossary,rules}`
and optionally a selection. The bridge JSON result uses arrays
`translations:[{review_id,field,text,uncertain:[]}], concerns:[], mappings:[],
findings:[], consistency:[], simulated_questions:[], rules_candidates:[]` and
optional `replacement,summary`. Every model ID and quote must be verified by the
service against the snapshot before publication. Backend jobs persist stage,
input snapshot/hash, model/prompt version, status and result; manual decisions
survive reruns. Editing invalidates current findings without calling an LLM.

## Delivery gates

Use scoped Python unit/HTTP tests, Node bridge/compiler checks, browser workflows
with mock LLM/OpenReview, two-browser Yjs verification, and the existing CI
checks. Golden fixtures contain at least 30 synthetic mapping cases. Live LLM
quality measurement is separate from deterministic structural verification.


Printed OpenReview PDFs and pasted page text are recognized by review headers
and named fields. Staged `structure` reports official/AI/comment counts and parser
version. Each proposed review may carry `source_type`, `suggested_include` and
`extraction` page provenance. Only official human reviews are selected by default;
AI reviews and chair comments remain available but optional. Navigation, abstract
and submission metadata remain in the immutable original, not reviewer fields.
Unrecognized formats remain one intact text record. Pending imports can be resumed
from the overview/review screen; reorganization retains previous proposals.
