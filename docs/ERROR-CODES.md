# EMET error codes

Every error EMET returns carries a stable code in `error.emet_code`. The existing `error.code` field is unchanged. The same meaning keeps the same code. A code is not reused and its meaning is not changed. A retired number stays reserved in the list below and is not issued again.

Internal codes are raised inside a check that catches them before a caller sees them. If one ever reaches a caller it is still that code, not a new one.

| Code | Summary | Status |
|---|---|---|
| EMET-AUTH-001 | Could not allocate a person id | active |
| EMET-AUTH-002 | CIMD document is not a JSON object | active, internal |
| EMET-AUTH-003 | CIMD client_id does not match its URL | active, internal |
| EMET-AUTH-004 | CIMD redirect_uris are missing | active, internal |
| EMET-AUTH-005 | CIMD client is not public | active, internal |
| EMET-AUTH-006 | CIMD host is not a public address | active, internal |
| EMET-AUTH-007 | CIMD host did not resolve | active, internal |
| EMET-AUTH-008 | CIMD host resolves to a blocked address | active, internal |
| EMET-AUTH-009 | CIMD fetch rate limit | active, internal |
| EMET-AUTH-010 | CIMD fetch returned an HTTP error | active, internal |
| EMET-AUTH-011 | CIMD document exceeds the size cap | active, internal |
| EMET-AUTH-012 | CIMD document is not valid JSON | active, internal |
| EMET-AUTH-013 | Authorization code is not recognised | active |
| EMET-AUTH-014 | Authorization code has expired | active |
| EMET-AUTH-015 | Redirect URI does not match the code | active |
| EMET-AUTH-016 | Authorization code has already been used | active |
| EMET-AUTH-017 | Refresh token is not recognised | active |
| EMET-AUTH-018 | Refresh token has expired | active |
| EMET-AUTH-019 | Login has no source tag bound | active |
| EMET-AUTH-020 | Refresh token has already been replaced | active |
| EMET-AUTH-021 | Member access login can no longer be refreshed | active |
| EMET-AUTH-022 | Invite login can no longer be refreshed | active |
| EMET-AUTH-023 | A refresh cannot widen scope | active |
| EMET-AUTH-024 | Access token is not recognised | active |
| EMET-AUTH-025 | Access token has expired | active |
| EMET-AUTH-026 | Sub-key open lost a race | active |
| EMET-AUTH-027 | Sub-key store conflict | active |
| EMET-AUTH-028 | Sub-key refusal | active |
| EMET-AUTH-029 | Guest display name is required | active |
| EMET-AUTH-030 | Guest access is off on this install | active |
| EMET-AUTH-031 | A guest invite accepts only read access | active |
| EMET-AUTH-032 | Guest invite source is not a registered tag | active |
| EMET-AUTH-033 | Member display name is required | active |
| EMET-AUTH-034 | Member access is off on this install | active |
| EMET-AUTH-035 | Member code source is not a registered tag | active |
| EMET-AUTH-036 | Only the owner can create invites | active |
| EMET-AUTH-037 | Only the owner can create member access | active |
| EMET-AUTH-038 | The error report is owner-only | active |
| EMET-AUTH-039 | HTTP attribution preflight was refused | active |
| EMET-AUTH-040 | A claimed source tag cannot write after the kill date | active |
| EMET-AUTH-041 | A credential was revoked by rotation | active |
| EMET-AUTH-042 | A retired owl credential was refused | active |
| EMET-AUTH-043 | A writer approval step was refused | active |
| EMET-AUTH-044 | A bound login cannot stamp another tag | active |
| EMET-CFG-001 | Database name must be a plain name | active, internal |
| EMET-CFG-002 | Collection prefix must be a plain name | active, internal |
| EMET-CFG-004 | Hosted setup cannot turn sub-keys on from here | active |
| EMET-CFG-005 | Could not read .env | active |
| EMET-CFG-006 | Could not write .env | active |
| EMET-CFG-007 | Startup page is not a whole number | active |
| EMET-CFG-008 | Startup page does not exist | active |
| EMET-CFG-009 | First-time setup was given a bot tag | active |
| EMET-CFG-010 | Setup is missing required answers | active |
| EMET-CFG-011 | Sub-key answer must be yes or no | active |
| EMET-CFG-012 | Backup answer must be yes or no | active |
| EMET-CFG-013 | Setup requires the owner | active |
| EMET-CFG-014 | Store is already set up | active |
| EMET-DB-001 | MONGODB_URI is not set | active |
| EMET-DB-002 | Failed to connect to MongoDB | active |
| EMET-DB-003 | Query failed on a memory layer | active |
| EMET-DB-004 | Count failed on a memory layer | active |
| EMET-DB-005 | Unknown layer field | active |
| EMET-DB-006 | Failed to write to primary storage | active |
| EMET-DB-007 | Invalid memory layer | active |
| EMET-DB-008 | Failed to initialize a layer schema | active |
| EMET-DB-010 | Unknown layer in a gap query | active |
| EMET-DB-013 | Failed to save memory | active |
| EMET-DB-014 | Failed to revise memory | active |
| EMET-DB-015 | Failed to recall memories | active |
| EMET-DB-016 | Failed to query a layer | active |
| EMET-DB-017 | Failed to get system status | active |
| EMET-DB-018 | Failed to query transcripts | active |
| EMET-DB-019 | Failed to save a session transcript | active |
| EMET-DB-020 | Session open could not load unhandled drops | active |
| EMET-DB-021 | Session open could not check a closed session | active |
| EMET-DB-022 | Failed to revise a transcript | active |
| EMET-DB-023 | Failed to read a document | active |
| EMET-DB-024 | Failed to read document history | active |
| EMET-DB-025 | Failed to write a document | active |
| EMET-DB-026 | Failed to list documents | active |
| EMET-DB-027 | Retirement mark did not persist | active |
| EMET-DB-028 | Retiring altered the document | active |
| EMET-DB-029 | Failed to retire a document | active |
| EMET-DB-030 | Failed to rename a document | active |
| EMET-DB-031 | Failed to validate a document | active |
| EMET-DB-032 | Acceptance did not persist | active |
| EMET-DB-033 | Failed to accept a nonconformance | active |
| EMET-DB-034 | Failed to patch a document | active |
| EMET-DB-035 | Failed semantic recall | active |
| EMET-DB-036 | Failed corpus recall | active |
| EMET-DB-037 | Failed to stage a document write | active |
| EMET-DOC-001 | doc_id must be a non-empty string | active |
| EMET-DOC-002 | Document not found | active |
| EMET-DOC-003 | No retained revision | active |
| EMET-DOC-004 | expected_version is not a whole number | active |
| EMET-DOC-005 | Document changed while paging | active |
| EMET-DOC-006 | Version must be a positive integer | active |
| EMET-DOC-007 | A record is superseded, not amended | active |
| EMET-DOC-008 | Doc id is not stored as given | active |
| EMET-DOC-009 | Client approvals are kept by the server | active |
| EMET-DOC-010 | A declared tag wrote outside its own folder | active |
| EMET-DOC-011 | A bot may write only its own records | active |
| EMET-DOC-012 | Bot records require a registered tag | active |
| EMET-DOC-013 | A bot tag cannot write a main record | active |
| EMET-DOC-014 | Main records require a registered tag | active |
| EMET-DOC-015 | Content must be a non-empty string | active |
| EMET-DOC-016 | Content exceeds the 2MB limit | active |
| EMET-DOC-017 | A record revision must name what it supersedes | active |
| EMET-DOC-018 | supersedes does not name the revision in force | active |
| EMET-DOC-019 | A record revision needs a reason | active |
| EMET-DOC-020 | Unregistered source may write a new drop only | active |
| EMET-DOC-021 | Drop cap for the day is reached | active |
| EMET-DOC-022 | An existing working document is edited, not rewritten | active |
| EMET-DOC-023 | A drop id already exists | active |
| EMET-DOC-024 | A shipped copy is not replaced | active |
| EMET-DOC-025 | A write would condense a document below half | active |
| EMET-DOC-026 | A write would fall below half of the daily peak | active |
| EMET-DOC-027 | The board is never retired | active |
| EMET-DOC-028 | Working documents are edited, not retired | active |
| EMET-DOC-029 | retire_doc needs a reason | active |
| EMET-DOC-030 | old_id must be a non-empty string | active |
| EMET-DOC-031 | new_id must be a non-empty string | active |
| EMET-DOC-032 | old_id and new_id name the same document | active |
| EMET-DOC-033 | rename_doc needs a reason | active |
| EMET-DOC-034 | The board is never renamed | active |
| EMET-DOC-035 | A drop is write-once | active |
| EMET-DOC-036 | Rename destination already exists | active |
| EMET-DOC-037 | restore_doc needs a reason | active |
| EMET-DOC-038 | restore_doc needs a source | active |
| EMET-DOC-039 | A drop is never restored | active |
| EMET-DOC-040 | A record is not restored | active |
| EMET-DOC-041 | A shipped copy is not restored | active |
| EMET-DOC-042 | Restore source is not in EMET_RESTORE_TAGS | active |
| EMET-DOC-043 | Retained revision does not match its digest | active |
| EMET-DOC-044 | Templated revision has no conformance verdict | active |
| EMET-DOC-045 | Retained revision was not conforming | active |
| EMET-DOC-046 | validate_doc needs a document or content | active |
| EMET-DOC-047 | Template does not ship with this release | active |
| EMET-DOC-048 | An acceptance needs a written reason | active |
| EMET-DOC-049 | An acceptance reason is too short | active |
| EMET-DOC-050 | Document has no nonconformance to accept | active |
| EMET-DOC-051 | A required name is empty | active |
| EMET-DOC-052 | Document version conflict | active |
| EMET-DOC-053 | Patch target text was not found | active |
| EMET-DOC-054 | Patch target text matched more than once | active |
| EMET-DOC-055 | patch_doc needs a reason | active |
| EMET-DOC-056 | patch_doc cannot edit a drop | active |
| EMET-DOC-057 | old_str must be a non-empty string | active |
| EMET-DOC-058 | new_str must be a string | active |
| EMET-DOC-059 | Patch edits overlap | active |
| EMET-DOC-060 | Stage not found for this writer | active |
| EMET-DOC-061 | Stage has expired | active |
| EMET-DOC-062 | Stage was aborted | active |
| EMET-DOC-063 | Stage is already committed | active |
| EMET-DOC-064 | A staged chunk exceeds the part limit | active |
| EMET-DOC-065 | A staged append is out of order | active |
| EMET-DOC-066 | A staged part was already stored with different bytes | active |
| EMET-DOC-067 | Staged content would exceed the 2MB limit | active |
| EMET-DOC-068 | A staged write has too many parts | active |
| EMET-DOC-069 | Commit digest does not match the assembled content | active |
| EMET-DOC-070 | Commit part count does not match the stage | active |
| EMET-DOC-071 | A staged chunk must be a non-empty string | active |
| EMET-DOC-072 | A staged part index must be a whole number | active |
| EMET-DOC-073 | Commit sha256 must be a hex digest | active |
| EMET-DOC-074 | Too many open stages for this writer | active |
| EMET-DOC-075 | Commit names a different document than the stage | active |
| EMET-DOC-076 | This stage is already being committed | active |
| EMET-DOC-077 | Commit supersedes does not match the stage | active |
| EMET-DOC-078 | Commit reason does not match the stage | active |
| EMET-DOC-079 | This call's source does not match the stage | active |
| EMET-DOC-080 | This call's session does not match the stage | active |
| EMET-GEM-001 | Read-back found no document | active |
| EMET-GEM-002 | Read-back content digest differs | active |
| EMET-GEM-003 | Read-back version differs | active |
| EMET-GEM-004 | Read-back found no layer entry | active |
| EMET-GEM-005 | Layer sha256 column does not match content | active |
| EMET-GEM-006 | Read-back content differs | active |
| EMET-GEM-007 | Metadata digest column does not match | active |
| EMET-GEM-008 | Read-back metadata differs | active |
| EMET-GEM-009 | Unknown floor section | active |
| EMET-GEM-010 | Unknown GEM | active |
| EMET-GEM-011 | GEM is not loadable | active |
| EMET-GEM-012 | GEM has no floor | active |
| EMET-GEM-013 | GEM manifest schema id | active, internal |
| EMET-GEM-014 | Unexpected end of JSON | active, internal |
| EMET-GEM-015 | Unexpected character in JSON | active, internal |
| EMET-GEM-016 | Unexpected token in JSON | active, internal |
| EMET-GEM-017 | Bad number in JSON | active, internal |
| EMET-GEM-018 | Bad escape in JSON | active, internal |
| EMET-GEM-019 | Raw control character in a JSON string | active, internal |
| EMET-GEM-020 | Unterminated JSON string | active, internal |
| EMET-GEM-021 | Trailing comma in JSON | active, internal |
| EMET-GEM-022 | Expected a comma in JSON | active, internal |
| EMET-GEM-023 | Unterminated JSON array | active, internal |
| EMET-GEM-024 | Expected a JSON key | active, internal |
| EMET-GEM-025 | Duplicate JSON key | active, internal |
| EMET-GEM-026 | Forbidden JSON key | active, internal |
| EMET-GEM-027 | Expected a colon in JSON | active, internal |
| EMET-GEM-028 | Unterminated JSON object | active, internal |
| EMET-GEM-029 | JSON starts with a BOM | active, internal |
| EMET-GEM-030 | Trailing data after JSON | active, internal |
| EMET-GEM-031 | JSON number is not a safe integer | active, internal |
| EMET-GEM-032 | Unsupported JSON value | active, internal |
| EMET-GEM-033 | Attestation is immutable | active |
| EMET-GEM-034 | metadata.gem must name the active directive | active |
| EMET-GEM-035 | Served artifact has no hash pin | active |
| EMET-GEM-036 | No authenticated principal | active |
| EMET-GEM-037 | Serve log could not be written | active |
| EMET-GEM-038 | No serve event | active |
| EMET-GEM-039 | Client-reported sha256 is not accepted here | active |
| EMET-GEM-040 | Input hash or reference is required | active |
| EMET-GEM-041 | Served rune has no hash pin | active |
| EMET-GEM-042 | GEM socket failed closed | active |
| EMET-INT-001 | Unclassified internal error | active |
| EMET-MEM-001 | Unknown memory layer | active |
| EMET-MEM-002 | Unknown importance bucket | active |
| EMET-MEM-003 | Unknown importance bucket name | active |
| EMET-MEM-004 | Unknown importance degree | active |
| EMET-MEM-005 | Lesson metadata was refused | active |
| EMET-MEM-006 | session_id must come from emet_session_open | active |
| EMET-MEM-007 | Transcript positions cannot be read | active |
| EMET-MEM-008 | An entry must carry its source | active |
| EMET-MEM-009 | A correction names a missing entry | active |
| EMET-MEM-010 | Episodic revision is prohibited | active |
| EMET-MEM-011 | target_id must be a positive integer | active |
| EMET-MEM-012 | No entry with that id in the layer | active |
| EMET-MEM-013 | Entry is already superseded | active |
| EMET-MEM-014 | order must be latest | active |
| EMET-MEM-015 | Search term exceeds the maximum length | active |
| EMET-MEM-016 | Session slug was refused | active |
| EMET-MEM-017 | session_id is required | active |
| EMET-MEM-018 | Machine check refused the append | active |
| EMET-MEM-019 | A bot tag cannot retire documents | active |
| EMET-MEM-020 | A bot tag cannot rename documents | active |
| EMET-MEM-021 | The board already exists | active |
| EMET-MEM-022 | The board is never written with write_doc | active |
| EMET-MEM-023 | The board is provisioned by setup | active |
| EMET-MEM-024 | A board edit needs a session id | active |
| EMET-MEM-025 | Board edit blocked: drop list unknown | active |
| EMET-MEM-026 | Unhandled drops block a board restore | active |
| EMET-MEM-027 | Unhandled drops block a board edit | active |
| EMET-MEM-028 | An added board row needs origin | active |
| EMET-MEM-029 | The board edit is nonconforming | active |
| EMET-MEM-030 | Query must be a non-empty string | active |
| EMET-MEM-032 | Corpus name is not recognised | active |
| EMET-MEM-034 | Only a ready payload can be abridged | active |
| EMET-PAGE-001 | as_of must be an ISO date or unix seconds | active |
| EMET-PAGE-002 | Only the owner can create or edit an area document | active |
| EMET-PAGE-003 | Only the owner can read topic pages | active |
| EMET-PAGE-004 | Area must be a slug | active |
| EMET-PAGE-005 | No current area document | active |
| EMET-PAGE-006 | Lint found no current area document | active |
| EMET-PAGE-007 | Startup pages could not fit the budget | active |
| EMET-PROV-001 | derived_from must be an object | active |
| EMET-PROV-002 | derived_from has two origins | active |
| EMET-PROV-003 | derived_from needs a span or entries | active |
| EMET-PROV-004 | derived_from.entries must be a non-empty array | active |
| EMET-PROV-005 | Entry ids must be positive integers | active |
| EMET-PROV-006 | derived_from.session_id must be a non-empty string | active |
| EMET-PROV-007 | exchange_start must be a positive integer | active |
| EMET-PROV-008 | exchange_end is before exchange_start | active |
| EMET-PROV-009 | exchange_end must be a positive integer | active |
| EMET-PROV-010 | Provenance entry is required | active |
| EMET-RATE-001 | Rate limit exceeded | active |
| EMET-SESS-001 | The transcript position is not available | active |
| EMET-SESS-002 | Transcript timestamps must be numbers | active |
| EMET-SESS-003 | timestamp_start must be before timestamp_end | active |
| EMET-SESS-004 | session_id must be a string | active |
| EMET-SESS-005 | Session graph is unavailable | active |
| EMET-SESS-006 | Session close was blocked | active |
| EMET-SESS-007 | Session close escalated | active |
| EMET-TOOL-001 | A tool has no annotation entry | active, internal |
| EMET-TOOL-002 | A source tag is required | active |
| EMET-TOOL-003 | A source tag is required and none are registered | active |
| EMET-TOOL-004 | Source tag is not registered | active |
| EMET-TOOL-005 | The call is outside the token scope | active |
| EMET-TOOL-006 | Exchange index was refused | active |
| EMET-TOOL-007 | Client approval was refused | active |
| EMET-TOOL-008 | Unknown tool | active |
| EMET-TOOL-009 | since must be an ISO date | active |
| EMET-TOOL-010 | since is older than 90 days | active |
| EMET-TOOL-011 | codes must be a list of EMET codes | active |
| EMET-TOOL-012 | limit must be a whole number from 1 to 200 | active |
| EMET-TOOL-013 | correlation_id must be 16 hex characters | active |
| EMET-TRN-001 | An exchange field exceeds the length cap | active |
| EMET-TRN-002 | Transcript request exceeds the length cap | active |
| EMET-TRN-003 | session_id must be a non-empty string | active |
| EMET-TRN-004 | session_start must be a Unix timestamp | active |
| EMET-TRN-005 | exchanges must be a non-empty array | active |
| EMET-TRN-006 | Exchange messages must be strings | active |
| EMET-TRN-007 | A transcript revision replaces the whole part | active |
| EMET-TRN-008 | A transcript correction needs a reason | active |
| EMET-TRN-009 | No transcript found under that session id | active |
| EMET-TRN-010 | exchange_index must be a whole number | active |
| EMET-VAL-001 | Content is required | active |
| EMET-VAL-002 | Content must be a string | active |
| EMET-VAL-003 | Content is shorter than the minimum | active |
| EMET-VAL-004 | Content exceeds the maximum length | active |
| EMET-VAL-005 | Query is required | active |
| EMET-VAL-006 | Query must be a string | active |
| EMET-VAL-007 | Query cannot be empty | active |
| EMET-VAL-008 | Query exceeds the maximum length | active |
| EMET-VAL-010 | Context must be a string | active |
| EMET-VAL-011 | Context exceeds the maximum length | active |
| EMET-VAL-012 | Layer is required | active |
| EMET-VAL-013 | Layer must be a string | active |
| EMET-VAL-014 | Invalid layer | active |
| EMET-VAL-015 | Value is required | active |
| EMET-VAL-016 | Value must be a number | active |
| EMET-VAL-017 | Value is outside the allowed range | active |
| EMET-VAL-018 | Metadata must be an object | active |
| EMET-VAL-019 | Metadata exceeds the maximum size | active |
| EMET-VAL-020 | metadata.session_id is not accepted | active |
| EMET-VAL-021 | expires_at disagrees with valid_until | active |
| EMET-VAL-022 | valid_until disagrees with expires_at | active |
| EMET-VAL-023 | Routing must be a plain object | active |
| EMET-VAL-024 | Value must be a boolean | active |
| EMET-VAL-025 | Invalid assertion_origin | active |
| EMET-VAL-026 | Value must be a string | active |
| EMET-VAL-027 | Custom metadata object is too large | active |
| EMET-VAL-028 | valid_from is after valid_until | active |
| EMET-VAL-029 | Value must be a positive integer | active |
| EMET-VAL-030 | Tags must be an array | active |
| EMET-VAL-031 | Too many tags | active |
| EMET-VAL-032 | Each tag must be a string | active |
| EMET-VAL-033 | Tag exceeds the maximum length | active |
| EMET-VAL-034 | Related ids must be an array | active |
| EMET-VAL-035 | Too many related ids | active |
| EMET-VAL-036 | Value exceeds the maximum length | active |
| EMET-VAL-037 | Filters must be an object | active |
| EMET-VAL-038 | Unknown importance bucket filter | active |
| EMET-VAL-039 | Content search term exceeds the maximum length | active |
| EMET-VAL-040 | Context search term exceeds the maximum length | active |
| EMET-VAL-041 | importance_min is greater than importance_max | active |
| EMET-VAL-042 | emotional_intensity_min is greater than the max | active |
| EMET-VAL-043 | timestamp_after is after timestamp_before | active |
| EMET-VAL-044 | Options must be an object | active |
| EMET-VAL-045 | order_by must be a string | active |
| EMET-VAL-046 | Arguments must be an object | active |

## Retired numbers

These numbers were removed from the registry. They stay reserved. A later removal is added here. The registry and the lock file do not list them.

| Code | Summary | Status |
|---|---|---|
| EMET-CFG-003 | MONGODB_URI is not set for setup | retired |
| EMET-DB-009 | MONGODB_URI is not set; cannot assess gaps | retired |
| EMET-DB-011 | MONGODB_URI is not set; cannot read topic pages | retired |
| EMET-DB-012 | MONGODB_URI is not set; cannot verify session artifacts | retired |
| EMET-MEM-031 | Query exceeds the maximum length | retired |
| EMET-MEM-033 | Startup pages could not fit the budget | retired |
| EMET-VAL-009 | Query exceeds the maximum length | retired |
