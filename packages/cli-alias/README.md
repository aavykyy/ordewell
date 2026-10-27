# ordewell

**[Ordewell](https://ordewell.ai)** turns one goal into an ordered plan of
coding-agent tasks, each with its own runner, model and mode, then runs the plan
and records each task's reported outcome.

```bash
npm install -g ordewell

ordewell          # full-screen terminal UI
ordewell --help   # every subcommand and option
```

Or without installing:

```bash
npx ordewell
```

This package is a thin alias. All of the code lives in
**[@ordewell/cli](https://www.npmjs.com/package/@ordewell/cli)**, which it
depends on at an exact version. Install either one and you get the same
`ordewell` command.

Node.js ≥ 20.3. Full documentation is at
**[github.com/ordewell/ordewell](https://github.com/ordewell/ordewell)**.
