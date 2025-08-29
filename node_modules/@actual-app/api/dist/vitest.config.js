"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = {
    test: {
        globals: true,
        onConsoleLog(log, type) {
            // print only console.error
            return type === 'stderr';
        },
    },
};
