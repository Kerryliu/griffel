import { NodePath, PluginObj, PluginPass, types as t } from '@babel/core';
import { declare } from '@babel/helper-plugin-utils';
import { Module } from '@linaria/babel-preset';
import shakerEvaluator from '@linaria/shaker';
import { resolveStyleRulesForSlots, CSSRulesByBucket, StyleBucketName, GriffelStyle } from '@griffel/core';
import * as path from 'path';

import { normalizeStyleRules } from './assets/normalizeStyleRules';
import { replaceAssetsWithImports } from './assets/replaceAssetsWithImports';
import { astify } from './utils/astify';
import { evaluatePaths } from './utils/evaluatePaths';
import { BabelPluginOptions } from './types';
import { validateOptions } from './validateOptions';

type BabelPluginState = PluginPass & {
  importDeclarationPaths?: NodePath<t.ImportDeclaration>[];
  requireDeclarationPath?: NodePath<t.VariableDeclarator>;

  definitionPaths?: NodePath<t.ObjectExpression>[];
  calleePaths?: NodePath<t.Identifier>[];
};

function getDefinitionPathFromMakeStylesCallExpression(
  callExpression: NodePath<t.CallExpression>,
): NodePath<t.ObjectExpression> {
  const argumentPaths = callExpression.get('arguments') as NodePath<t.Node>[];
  const hasValidArguments = Array.isArray(argumentPaths) && argumentPaths.length === 1;

  if (!hasValidArguments) {
    throw new Error('makeStyles() function accepts only a single param');
  }

  const definitionsPath = argumentPaths[0];

  if (!definitionsPath.isObjectExpression()) {
    throw definitionsPath.buildCodeFrameError('makeStyles() function accepts only an object as a param');
  }

  return definitionsPath;
}

/**
 * Checks that passed callee imports makesStyles().
 */
function isMakeStylesCallee(
  path: NodePath<t.Expression | t.V8IntrinsicIdentifier>,
  modules: NonNullable<BabelPluginOptions['modules']>,
): path is NodePath<t.Identifier> {
  if (path.isIdentifier()) {
    return Boolean(modules.find(module => path.referencesImport(module.moduleSource, module.importName)));
  }

  return false;
}

/**
 * Checks if import statement import makeStyles().
 */
function hasMakeStylesImport(
  path: NodePath<t.ImportDeclaration>,
  modules: NonNullable<BabelPluginOptions['modules']>,
): boolean {
  return Boolean(modules.find(module => path.node.source.value === module.moduleSource));
}

/**
 * Checks that passed declarator imports makesStyles().
 *
 * @example react_make_styles_1 = require('@griffel/react')
 */
function isRequireDeclarator(
  path: NodePath<t.VariableDeclarator>,
  modules: NonNullable<BabelPluginOptions['modules']>,
): boolean {
  const initPath = path.get('init');

  if (!initPath.isCallExpression()) {
    return false;
  }

  if (initPath.get('callee').isIdentifier({ name: 'require' })) {
    const args = initPath.get('arguments');

    if (Array.isArray(args) && args.length === 1) {
      const moduleNamePath = args[0];

      if (moduleNamePath.isStringLiteral()) {
        return Boolean(modules.find(module => moduleNamePath.node.value === module.moduleSource));
      }
    }
  }

  return false;
}

/**
 * Rules that are returned by `resolveStyles()` are not deduplicated.
 * It's critical to filter out duplicates for build-time transform to avoid duplicated rules in a bundle.
 */
function dedupeCSSRules(cssRules: CSSRulesByBucket): CSSRulesByBucket {
  (Object.keys(cssRules) as StyleBucketName[]).forEach(styleBucketName => {
    cssRules[styleBucketName] = cssRules[styleBucketName]!.filter(
      (rule, index, rules) => rules.indexOf(rule) === index,
    );
  });

  return cssRules;
}

export const transformPlugin = declare<Partial<BabelPluginOptions>, PluginObj<BabelPluginState>>((api, options) => {
  api.assertVersion(7);

  const pluginOptions: Required<BabelPluginOptions> = {
    babelOptions: {},
    modules: [
      { moduleSource: '@griffel/react', importName: 'makeStyles' },
      { moduleSource: '@fluentui/react-components', importName: 'makeStyles' },
    ],
    evaluationRules: [
      { action: shakerEvaluator },
      {
        test: /[/\\]node_modules[/\\]/,
        action: 'ignore',
      },
    ],
    projectRoot: process.cwd(),

    ...options,
  };

  validateOptions(pluginOptions);

  return {
    name: '@griffel/babel-plugin-transform',

    pre() {
      this.importDeclarationPaths = [];
      this.definitionPaths = [];
      this.calleePaths = [];
    },

    visitor: {
      Program: {
        enter(programPath, state) {
          if (typeof state.filename === 'undefined') {
            throw new Error(
              [
                '@griffel/babel-preset: This preset requires "filename" option to be specified by Babel. ',
                "It's automatically done by Babel and our loaders/plugins. ",
                "If you're facing this issue, please check your setup.\n\n",
                'See: https://babeljs.io/docs/en/options#filename',
              ].join(''),
            );
          }

          // Invalidate cache for module evaluation to get fresh modules
          Module.invalidate();
        },

        exit(programPath, state) {
          if (state.importDeclarationPaths!.length === 0 && !state.requireDeclarationPath) {
            return;
          }

          if (state.definitionPaths) {
            // Runs Babel AST processing or module evaluation for Node once for all arguments of makeStyles() calls once
            evaluatePaths(programPath, state.file.opts.filename!, state.definitionPaths, pluginOptions);

            state.definitionPaths.forEach(definitionPath => {
              const callExpressionPath = definitionPath.findParent(parentPath =>
                parentPath.isCallExpression(),
              ) as NodePath<t.CallExpression>;
              const evaluationResult = definitionPath.evaluate();

              if (!evaluationResult.confident) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const deoptPath = (evaluationResult as any).deopt as NodePath | undefined;
                throw (deoptPath || definitionPath).buildCodeFrameError(
                  'Evaluation of a code fragment failed, this is a bug, please report it',
                );
              }

              const stylesBySlots: Record<string /* slot */, GriffelStyle> = evaluationResult.value;
              const [classnamesMapping, cssRulesByBucket] = resolveStyleRulesForSlots(
                // Heads up!
                // Style rules should be normalized *before* they will be resolved to CSS rules to have deterministic
                // results across different build targets.
                normalizeStyleRules(
                  path,
                  pluginOptions.projectRoot,
                  // Presence of "state.filename" is validated on `Program.enter()`
                  state.filename as string,
                  stylesBySlots,
                ),
              );
              const uniqueCSSRules = dedupeCSSRules(cssRulesByBucket);

              (callExpressionPath.get('arguments.0') as NodePath).remove();
              callExpressionPath.pushContainer('arguments', [astify(classnamesMapping), astify(uniqueCSSRules)]);

              replaceAssetsWithImports(pluginOptions.projectRoot, state.filename!, programPath, callExpressionPath);
            });
          }

          state.importDeclarationPaths!.forEach(importDeclarationPath => {
            const specifiers = importDeclarationPath.get('specifiers');
            const source = importDeclarationPath.get('source');

            specifiers.forEach(specifier => {
              if (specifier.isImportSpecifier()) {
                // TODO: should use generated modifier to avoid collisions

                const importedPath = specifier.get('imported');
                const importIdentifierPath = pluginOptions.modules.find(module => {
                  return (
                    module.moduleSource === source.node.value &&
                    // 👆 "moduleSource" should match "importDeclarationPath.source" to skip unrelated ".importName"
                    importedPath.isIdentifier({ name: module.importName })
                  );
                });

                if (importIdentifierPath) {
                  specifier.replaceWith(t.identifier('__styles'));
                }
              }
            });
          });

          if (state.calleePaths) {
            state.calleePaths.forEach(calleePath => {
              calleePath.replaceWith(t.identifier('__styles'));
            });
          }
        },
      },

      // eslint-disable-next-line @typescript-eslint/naming-convention
      ImportDeclaration(path, state) {
        if (hasMakeStylesImport(path, pluginOptions.modules)) {
          state.importDeclarationPaths!.push(path);
        }
      },

      // eslint-disable-next-line @typescript-eslint/naming-convention
      VariableDeclarator(path, state) {
        if (isRequireDeclarator(path, pluginOptions.modules)) {
          state.requireDeclarationPath = path;
        }
      },

      // eslint-disable-next-line @typescript-eslint/naming-convention
      CallExpression(path, state) {
        /**
         * Handles case when `makeStyles()` is `CallExpression`.
         *
         * @example makeStyles({})
         */
        if (state.importDeclarationPaths!.length === 0) {
          return;
        }

        const calleePath = path.get('callee');

        if (!isMakeStylesCallee(calleePath, pluginOptions.modules)) {
          return;
        }

        state.definitionPaths!.push(getDefinitionPathFromMakeStylesCallExpression(path));
        state.calleePaths!.push(calleePath);
      },

      // eslint-disable-next-line @typescript-eslint/naming-convention
      MemberExpression(expressionPath, state) {
        /**
         * Handles case when `makeStyles()` is inside `MemberExpression`.
         *
         * @example module.makeStyles({})
         */
        if (!state.requireDeclarationPath) {
          return;
        }

        const objectPath = expressionPath.get('object');
        const propertyPath = expressionPath.get('property');

        const isMakeStylesCall =
          objectPath.isIdentifier({ name: (state.requireDeclarationPath.node.id as t.Identifier).name }) &&
          propertyPath.isIdentifier({ name: 'makeStyles' });

        if (!isMakeStylesCall) {
          return;
        }

        const parentPath = expressionPath.parentPath;

        if (!parentPath.isCallExpression()) {
          return;
        }

        state.definitionPaths!.push(getDefinitionPathFromMakeStylesCallExpression(parentPath));
        state.calleePaths!.push(propertyPath as NodePath<t.Identifier>);
      },
    },
  };
});
