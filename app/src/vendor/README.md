# Vendored components

Code copied from other projects, kept apart from Theoremis's own so its license and origin stay
clear. Each folder holds its upstream license. The full notices are in
[THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

| Folder | What | From | License |
| --- | --- | --- | --- |
| `thinking-orbs/` | The animated canvas orb the collaborator shows while it thinks and works | [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) `packages/thinking-orbs/src` at `422180dd`, via [Agents Kit](https://github.com/agents-ui/agents-kit) at `d84eceae` | MIT |
| `react-bits/` | `ShinyText`, `GradientText`, `StarBorder`, `ClickSpark`, `GradualBlur`, `SpotlightCard` | [React Bits](https://github.com/DavidHDev/react-bits) `src/ts-default` at `e12c2219` | MIT + Commons Clause |

Local changes, kept to what Theoremis's compiler settings require:

- `thinking-orbs/engine/core.ts`: the unused `rMin` parameter of `paint` is named `_rMin`
  (`noUnusedParameters`). Its position and default are unchanged.

Use these through the wrappers in `components/ai/`, which set Theoremis's colours, sizes and
reduced-motion behaviour, rather than importing them directly.

React Bits' Commons Clause allows using the components as part of Theoremis, including
commercially, but not selling or redistributing the components themselves, alone or as a
port. Don't copy them out of Theoremis into a component library.
