import { applyDocumentTheme, readCachedTheme } from './theme';

const theme = readCachedTheme();

if (theme !== undefined) {
    applyDocumentTheme(theme);
}
