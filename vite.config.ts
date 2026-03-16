import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';

// Plugin to convert dynamic imports to static imports for Chrome extension compatibility.
// Chrome MV3 content scripts and service workers cannot use dynamic import().
function inlineDynamicImportsPlugin(): Plugin {
  return {
    name: 'inline-dynamic-imports',
    // Rewrite dynamic import() to static import so Rollup bundles them inline
    transform(code, id) {
      if (id.includes('page-controller')) {
        // Replace: const { SimulatorMask } = await import("./SimulatorMask-BHnQ6LmL.js");
        // With a static import at the top that gets tree-shaken into the bundle
        const dynamicImportRe = /const\s*\{\s*SimulatorMask\s*\}\s*=\s*await\s+import\s*\(\s*["']\.\/SimulatorMask[^"']*["']\s*\)/;
        if (dynamicImportRe.test(code)) {
          // Get the directory of the current file to resolve the relative import
          const dir = id.substring(0, id.lastIndexOf('/'));
          // Find the actual SimulatorMask file
          const simulatorFile = dir + '/SimulatorMask-BHnQ6LmL.js';

          // Add a static import at the top and replace the dynamic import with the reference
          code = `import { SimulatorMask as __SimulatorMask__ } from '${simulatorFile}';\n` + code;
          code = code.replace(
            dynamicImportRe,
            'const { SimulatorMask } = { SimulatorMask: __SimulatorMask__ }',
          );
          return { code, map: null };
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [inlineDynamicImportsPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'background/index': resolve(__dirname, 'src/background/index.ts'),
        'offscreen/worker': resolve(__dirname, 'src/offscreen/worker.ts'),
        'sidepanel/main': resolve(__dirname, 'src/sidepanel/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    target: 'esnext',
    minify: false,
    sourcemap: false,
    cssCodeSplit: false,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
