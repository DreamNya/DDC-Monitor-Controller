// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
    {
        files: ['src/**/*.{ts,tsx}', 'scripts/**/*.{ts,js,mjs,cjs}'],
        extends: [js.configs.recommended, tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
            'prefer-const': 'error',
            'one-var': ['error', 'never'],
            'one-var-declaration-per-line': ['error', 'always'],
            curly: ['error', 'all'],
            '@typescript-eslint/no-this-alias': [
                'error',
                {
                    allowedNames: ['adapter'],
                },
            ],
            '@typescript-eslint/no-unsafe-function-type': 'off',
        },
    },
]);
