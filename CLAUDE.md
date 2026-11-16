# open-reel

An open source project that takes contributions from the community.

## Language

Everything that goes into the repository is written in English, whatever
language the conversation is in:

- code: identifiers, comments, string literals, error messages and UI text;
- tests: names and descriptions;
- documentation, commit messages, pull requests and issues.

## Checks

Run all three before calling a change done:

```sh
bun test && bun run typecheck && bun run lint
```

`bun run format` fixes formatting and import order.
