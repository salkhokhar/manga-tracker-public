// Lets `node --test` require the app's .ts modules directly. Each file is
// transpiled (types stripped, no type-check) with the project's own TypeScript,
// so tests run against exactly what ships. Only pure modules can be loaded this
// way; anything importing react-native / expo will fail to resolve.
const fs = require('fs');
const ts = require('typescript');

require.extensions['.ts'] = function (module, filename) {
    const src = fs.readFileSync(filename, 'utf8');
    const out = ts.transpileModule(src, {
        fileName: filename,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
    });
    module._compile(out.outputText, filename);
};
