import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, extname, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const INDEX_TS_SUFFIXES = TS_EXTENSIONS.map(ext => `/index${ext}`);
const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

function isModuleNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND';
}

function isRelativePath(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

function isActualSourceUrl(url?: string): boolean {
  if (!url || !url.startsWith('file:')) {
    return false;
  }

  const normalizedUrl = url.replace(/\\/g, '/');
  return normalizedUrl.includes('/node_modules/@actual-app/') && normalizedUrl.includes('/src/');
}

function shouldRetryWithTsExtension(specifier: string, parentURL?: string): boolean {
  return isActualSourceUrl(parentURL) && isRelativePath(specifier) && extname(specifier) === '';
}

function isActualTypescriptUrl(url: string): boolean {
  return isActualSourceUrl(url) && /\.(cts|mts|ts|tsx)$/.test(url);
}

function normalizeRelativeSpecifier(specifierPath: string): string {
  const normalized = specifierPath.replace(/\\/g, '/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function resolveActualRelativeSpecifier(parentUrl: string, specifier: string): string {
  if (!isRelativePath(specifier) || extname(specifier) !== '') {
    return specifier;
  }

  const parentPath = fileURLToPath(parentUrl);
  const parentDir = dirname(parentPath);
  const basePath = resolvePath(parentDir, specifier);
  const candidates = [
    ...TS_EXTENSIONS.map(extension => `${basePath}${extension}`),
    ...TS_EXTENSIONS.map(extension => resolvePath(basePath, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return normalizeRelativeSpecifier(relative(parentDir, candidate));
    }
  }

  return specifier;
}

function rewriteActualRelativeSpecifiers(url: string, source: string): string {
  const rewrite = (specifier: string) => resolveActualRelativeSpecifier(url, specifier);

  return source
    .replace(/\bfrom\s+(['"])([^'"]+)\1/g, (match, quote, specifier) => {
      return `from ${quote}${rewrite(specifier)}${quote}`;
    })
    .replace(/\bimport\s+(['"])([^'"]+)\1/g, (match, quote, specifier) => {
      return `import ${quote}${rewrite(specifier)}${quote}`;
    })
    .replace(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (match, quote, specifier) => {
      return `import(${quote}${rewrite(specifier)}${quote})`;
    });
}

function transpileActualTypescript(url: string, source: string): string {
  return ts.transpileModule(rewriteActualRelativeSpecifiers(url, source), {
    fileName: fileURLToPath(url),
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      inlineSourceMap: true,
      inlineSources: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    reportDiagnostics: false,
  }).outputText;
}

registerHooks({
  load(url, context, nextLoad) {
    if (!isActualTypescriptUrl(url)) {
      return nextLoad(url, context);
    }

    const source = readFileSync(new URL(url), 'utf8');
    return {
      format: 'commonjs',
      shortCircuit: true,
      source: transpileActualTypescript(url, source),
    };
  },
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!isModuleNotFound(error) || !shouldRetryWithTsExtension(specifier, context.parentURL)) {
        throw error;
      }

      for (const candidate of [
        ...TS_EXTENSIONS.map(extension => `${specifier}${extension}`),
        ...INDEX_TS_SUFFIXES.map(suffix => `${specifier}${suffix}`),
      ]) {
        try {
          return nextResolve(candidate, context);
        } catch (candidateError) {
          if (!isModuleNotFound(candidateError)) {
            throw candidateError;
          }
        }
      }

      throw error;
    }
  },
});