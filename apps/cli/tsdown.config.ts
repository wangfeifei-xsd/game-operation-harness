import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships its command and the profile lifecycle shared with Desktop.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: { bin: 'lib/types/installed-bin.js', 'harness-embed-runtime': 'lib/types/harness-embed-runtime.js', 'profile-boot': 'lib/types/profile-boot.js', 'model-composition': 'lib/types/model-composition.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
