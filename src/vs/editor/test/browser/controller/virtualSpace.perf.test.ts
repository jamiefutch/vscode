/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CoreNavigationCommands } from '../../../browser/coreCommands.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import { CursorMove } from '../../../common/cursor/cursorMoveCommands.js';
import { TextModel } from '../../../common/model/textModel.js';
import { PositionAffinity } from '../../../common/model.js';
import { withTestCodeEditor } from '../testCodeEditor.js';

/**
 * Performance regression tests for virtual space.
 *
 * These tests use operation counting at the TextModel prototype level
 * to ensure virtual space operations remain O(line_length) or O(cursor_count),
 * not O(document_size).
 *
 * We monkey-patch hot methods like getLineContent, getLineMaxColumn before
 * creating the editor, then assert that operations on small vs large models
 * touch a bounded number of lines, independent of document size.
 */
suite('Editor Virtual Space Performance', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface ModelAccessCount {
		getLineContent: number;
		getLineMaxColumn: number;
		getLineLength: number;
		getLineCount: number;
		normalizePosition: number;
	}

	function createEmptyCounts(): ModelAccessCount {
		return { getLineContent: 0, getLineMaxColumn: 0, getLineLength: 0, getLineCount: 0, normalizePosition: 0 };
	}

	function resetCounts(counts: ModelAccessCount): void {
		counts.getLineContent = 0;
		counts.getLineMaxColumn = 0;
		counts.getLineLength = 0;
		counts.getLineCount = 0;
		counts.normalizePosition = 0;
	}

	// Shared counters and prototype patching — installed once for the suite
	const counts = createEmptyCounts();
	type TextModelProto = typeof TextModel.prototype;
	let origGetLineContent: TextModelProto['getLineContent'];
	let origGetLineMaxColumn: TextModelProto['getLineMaxColumn'];
	let origGetLineLength: TextModelProto['getLineLength'];
	let origGetLineCount: TextModelProto['getLineCount'];
	let origNormalizePosition: TextModelProto['normalizePosition'];
	let installed = false;

	function installCounters(): void {
		if (installed) { return; }
		installed = true;
		const proto = TextModel.prototype;

		origGetLineContent = proto.getLineContent;
		proto.getLineContent = function (lineNumber: number) {
			counts.getLineContent++;
			return origGetLineContent.call(this, lineNumber);
		};

		origGetLineMaxColumn = proto.getLineMaxColumn;
		proto.getLineMaxColumn = function (lineNumber: number) {
			counts.getLineMaxColumn++;
			return origGetLineMaxColumn.call(this, lineNumber);
		};

		origGetLineLength = proto.getLineLength;
		proto.getLineLength = function (lineNumber: number) {
			counts.getLineLength++;
			return origGetLineLength.call(this, lineNumber);
		};

		origGetLineCount = proto.getLineCount;
		proto.getLineCount = function () {
			counts.getLineCount++;
			return origGetLineCount.call(this);
		};

		origNormalizePosition = proto.normalizePosition;
		proto.normalizePosition = function (position: Position, affinity: PositionAffinity) {
			counts.normalizePosition++;
			return origNormalizePosition.call(this, position, affinity);
		};
	}

	function restoreCounters(): void {
		if (!installed) { return; }
		installed = false;
		const proto = TextModel.prototype;
		proto.getLineContent = origGetLineContent;
		proto.getLineMaxColumn = origGetLineMaxColumn;
		proto.getLineLength = origGetLineLength;
		proto.getLineCount = origGetLineCount;
		proto.normalizePosition = origNormalizePosition;
	}

	function generateModel(lineCount: number, lineLength: number = 80): string {
		const lines: string[] = [];
		for (let i = 0; i < lineCount; i++) {
			const prefix = `line${i}: `;
			const padding = 'x'.repeat(Math.max(0, lineLength - prefix.length));
			lines.push(prefix + padding);
		}
		return lines.join('\n');
	}

	suiteSetup(() => {
		installCounters();
	});

	suiteTeardown(() => {
		restoreCounters();
	});

	test('moveRight in virtual space should be O(1) regardless of document size', () => {
		let smallCounts = createEmptyCounts();

		// Test with 100 lines
		const textSmall = generateModel(100);
		withTestCodeEditor(textSmall, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(1, model.getLineMaxColumn(1)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			for (let i = 0; i < 100; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			smallCounts = { ...counts };
		});

		let largeCounts = createEmptyCounts();

		// Test with 10000 lines
		const textLarge = generateModel(10000);
		withTestCodeEditor(textLarge, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(1, model.getLineMaxColumn(1)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			for (let i = 0; i < 100; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			largeCounts = { ...counts };
		});

		// Assert: operation counts should be identical (O(1) per operation)
		assert.strictEqual(smallCounts.getLineMaxColumn, largeCounts.getLineMaxColumn,
			`getLineMaxColumn: small=${smallCounts.getLineMaxColumn} large=${largeCounts.getLineMaxColumn}`);
		assert.strictEqual(smallCounts.getLineContent, largeCounts.getLineContent,
			`getLineContent: small=${smallCounts.getLineContent} large=${largeCounts.getLineContent}`);

		// Assert: counts should be small (bounded by operation count, not document size)
		assert.ok(smallCounts.getLineMaxColumn <= 200,
			`getLineMaxColumn should be called at most 200 times, got ${smallCounts.getLineMaxColumn}`);
	});

	test('moveLeft from virtual space should be O(line_length) regardless of document size', () => {
		let smallCounts = createEmptyCounts();

		const textSmall = generateModel(100);
		withTestCodeEditor(textSmall, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(1, model.getLineMaxColumn(1)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Left });
			}

			smallCounts = { ...counts };
		});

		let largeCounts = createEmptyCounts();

		const textLarge = generateModel(10000);
		withTestCodeEditor(textLarge, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(1, model.getLineMaxColumn(1)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Left });
			}

			largeCounts = { ...counts };
		});

		// Assert: operation counts should be identical (O(line_length) per operation)
		assert.strictEqual(smallCounts.getLineContent, largeCounts.getLineContent,
			`getLineContent: small=${smallCounts.getLineContent} large=${largeCounts.getLineContent}`);
		assert.strictEqual(smallCounts.normalizePosition, largeCounts.normalizePosition,
			`normalizePosition: small=${smallCounts.normalizePosition} large=${largeCounts.normalizePosition}`);

		assert.ok(smallCounts.getLineContent <= 100,
			`getLineContent should be called at most 100 times, got ${smallCounts.getLineContent}`);
	});

	test('vertical movement with virtual space should be O(line_length) regardless of document size', () => {
		let smallCounts = createEmptyCounts();

		const textSmall = generateModel(100);
		withTestCodeEditor(textSmall, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(50, model.getLineMaxColumn(50)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Down, by: CursorMove.RawUnit.WrappedLine });
			}

			smallCounts = { ...counts };
		});

		let largeCounts = createEmptyCounts();

		const textLarge = generateModel(10000);
		withTestCodeEditor(textLarge, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(5000, model.getLineMaxColumn(5000)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Down, by: CursorMove.RawUnit.WrappedLine });
			}

			largeCounts = { ...counts };
		});

		assert.strictEqual(smallCounts.getLineContent, largeCounts.getLineContent,
			`getLineContent: small=${smallCounts.getLineContent} large=${largeCounts.getLineContent}`);

		assert.ok(smallCounts.getLineContent <= 100,
			`getLineContent should be called at most 100 times, got ${smallCounts.getLineContent}`);
	});

	test('typing in virtual space should be O(leftoverVisibleColumns) regardless of document size', () => {
		let smallCounts = createEmptyCounts();

		const textSmall = generateModel(100);
		withTestCodeEditor(textSmall, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(1, model.getLineMaxColumn(1)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			viewModel.type('x', 'keyboard');

			smallCounts = { ...counts };
		});

		let largeCounts = createEmptyCounts();

		const textLarge = generateModel(10000);
		withTestCodeEditor(textLarge, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;
			CoreNavigationCommands.MoveTo.runCoreEditorCommand(viewModel, { position: new Position(1, model.getLineMaxColumn(1)) });
			for (let i = 0; i < 10; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			viewModel.type('x', 'keyboard');

			largeCounts = { ...counts };
		});

		assert.strictEqual(smallCounts.getLineMaxColumn, largeCounts.getLineMaxColumn,
			`getLineMaxColumn: small=${smallCounts.getLineMaxColumn} large=${largeCounts.getLineMaxColumn}`);

		assert.ok(smallCounts.getLineMaxColumn <= 10,
			`getLineMaxColumn should be called at most 10 times, got ${smallCounts.getLineMaxColumn}`);
	});

	test('multi-cursor virtual space operations should be O(cursor_count) regardless of document size', () => {
		let smallCounts = createEmptyCounts();

		const textSmall = generateModel(100);
		withTestCodeEditor(textSmall, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;

			const selections: Selection[] = [];
			for (let i = 0; i < 10; i++) {
				const lineNumber = i + 1;
				selections.push(new Selection(lineNumber, model.getLineMaxColumn(lineNumber), lineNumber, model.getLineMaxColumn(lineNumber)));
			}
			editor.setSelections(selections);

			for (let i = 0; i < 5; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			viewModel.type('x', 'keyboard');

			smallCounts = { ...counts };
		});

		let largeCounts = createEmptyCounts();

		const textLarge = generateModel(10000);
		withTestCodeEditor(textLarge, { virtualSpace: true }, (editor, viewModel) => {
			const model = viewModel.model;

			const selections: Selection[] = [];
			for (let i = 0; i < 10; i++) {
				const lineNumber = i + 1;
				selections.push(new Selection(lineNumber, model.getLineMaxColumn(lineNumber), lineNumber, model.getLineMaxColumn(lineNumber)));
			}
			editor.setSelections(selections);

			for (let i = 0; i < 5; i++) {
				CoreNavigationCommands.CursorMove.runCoreEditorCommand(viewModel, { to: CursorMove.RawDirection.Right });
			}

			resetCounts(counts);

			viewModel.type('x', 'keyboard');

			largeCounts = { ...counts };
		});

		assert.strictEqual(smallCounts.getLineMaxColumn, largeCounts.getLineMaxColumn,
			`getLineMaxColumn: small=${smallCounts.getLineMaxColumn} large=${largeCounts.getLineMaxColumn}`);

		assert.ok(smallCounts.getLineMaxColumn <= 50,
			`getLineMaxColumn should be called at most 50 times (10 cursors * 5 ops), got ${smallCounts.getLineMaxColumn}`);
	});
});
