import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  // package.json is `"type": "module"`, so emit `.js` / `.d.ts` to match its main and types paths.
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
