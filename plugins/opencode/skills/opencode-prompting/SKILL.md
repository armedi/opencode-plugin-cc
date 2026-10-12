---
name: opencode-prompting
description: Best practices for crafting effective prompts when delegating tasks to OpenCode
user-invocable: false
---

# OpenCode Prompting

The parent prepares the prompt; the rescue child forwards it unchanged. OpenCode does not inherit the Claude conversation.

Give OpenCode the user's request and the context needed to carry it out. For an earlier plan, fix, or decision, reference its existing artifact by path or URL, or include the material inline if it exists only in chat.

Include relevant constraints, findings, attempted fixes, and verification criteria. Preserve the user's scope, distinguish unresolved choices, and identify later updates that supersede artifacts. Redact sensitive information.

Have OpenCode read required sources and report any it cannot access. Ask the user about missing or ambiguous context before dispatch. Fresh and resumed sessions both need relevant new context.

For task-specific examples, see [prompt recipes](references/opencode-prompt-recipes.md). For vague or conflicting requests, see [anti-patterns](references/opencode-prompt-antipatterns.md).
