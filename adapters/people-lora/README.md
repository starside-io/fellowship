# people-lora

No weights ship here, and none are needed. Fellowship is model agnostic: the
module never calls a model.

The three drafting jobs (sender matching, fact extraction, sketch drafting)
are two tool calls each, for whatever model is driving:

1. `people.draft_context` returns the material, the rules and the JSON schema.
2. `people.propose_draft` takes the model's answer, validates it against the
   same schema, drops invented people and fields and any sketch that reads as
   a diagnosis, and queues what survives for review.

Claude, GPT, Gemini or a local model behind any MCP client all do it the same
way, and all meet the same gates. A person confirming a proposal is the only
thing that writes.

The standalone app has one optional built in drafter, for when no assistant
is attached. It runs the same two calls with a model reached through the
models port:

| Variable | Default |
| --- | --- |
| `FELLOWSHIP_MODEL_URL` | `http://localhost:11434/v1` (any OpenAI compatible endpoint) |
| `FELLOWSHIP_MODEL` | `llama3.1` |

Leave it unconfigured and nothing breaks: the "Draft" buttons say no model is
listening, and every assistant path still works. A LoRA here would make a
small local model better at the three jobs. It would not change what they are
allowed to do.
