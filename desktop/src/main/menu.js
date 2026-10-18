// @ts-check
// ── The application menu ──────────────────────────────────────────────────────
// Menu items send a command to the window ("menu:command"), which does the
// same thing as the toolbar button or shortcut. Shortcuts are handled by the
// window itself (so they work the same from the keyboard, in tests and with
// the menu); the menu shows them without registering them — except the
// standard Edit items on macOS, which text fields there need.
'use strict';

/**
 * @param {{ send: (cmd: string) => void, isMac: boolean, dev: boolean, appName: string }} o
 */
function menuTemplate(o) {
  const mac = o.isMac;
  /** @param {string} label @param {string} cmd @param {string} [accel] */
  const item = (label, cmd, accel) => ({ label, accelerator: accel, registerAccelerator: false, click: () => o.send(cmd) });
  const sep = { type: 'separator' };
  // macOS needs the system's Edit items for copy and paste in text fields;
  // elsewhere the page handles those keys itself
  /** @param {string} role @param {string} label @param {string} accel */
  const editRole = (role, label, accel) => (mac ? { role, label, accelerator: accel } : { role, label, accelerator: accel, registerAccelerator: false });
  return [
    ...(mac ? [{ label: o.appName, submenu: [item('About ' + o.appName, 'about'), sep, item('Settings…', 'settings', 'Cmd+,'), sep, { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }] }] : []),
    {
      label: '&File',
      submenu: [
        item('New Workbook', 'new', 'CmdOrCtrl+N'),
        item('Open…', 'open', 'CmdOrCtrl+O'),
        item('Home (All Workbooks)', 'home', 'CmdOrCtrl+Shift+H'),
        sep,
        item('Import Excel or CSV…', 'import', 'CmdOrCtrl+Shift+I'),
        sep,
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        item('Rename Workbook…', 'renameWorkbook'),
        item('Duplicate Workbook', 'duplicateWorkbook'),
        sep,
        item('Export as Excel (.xlsx)…', 'exportXlsx', 'CmdOrCtrl+Shift+E'),
        item('Export Sheet as CSV…', 'exportCsv'),
        item('Export Sheet as TSV…', 'exportTsv'),
        sep,
        item('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        ...(mac ? [] : [sep, item('Settings…', 'settings', 'Ctrl+,'), sep, { role: 'quit', label: 'E&xit' }])
      ]
    },
    {
      label: '&Edit',
      submenu: [
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        item('Redo', 'redo', mac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
        sep,
        editRole('cut', 'Cut', 'CmdOrCtrl+X'),
        editRole('copy', 'Copy', 'CmdOrCtrl+C'),
        editRole('paste', 'Paste', 'CmdOrCtrl+V'),
        item('Paste Values Only', 'pasteValues', 'CmdOrCtrl+Shift+V'),
        item('Clear Contents', 'clear', 'Delete'),
        editRole('selectAll', 'Select All', 'CmdOrCtrl+A'),
        sep,
        item('Fill Down', 'fillDown', 'CmdOrCtrl+D'),
        item('Fill Right', 'fillRight', 'CmdOrCtrl+R'),
        sep,
        item('Find…', 'find', 'CmdOrCtrl+F'),
        item('Find and Replace…', 'replace', mac ? 'Cmd+Alt+F' : 'Ctrl+H')
      ]
    },
    {
      label: '&View',
      submenu: [
        item('Sidebar', 'toggleSidebar', 'CmdOrCtrl+Alt+B'),
        item('Formula Bar', 'toggleFormulaBar'),
        item('Gridlines', 'toggleGridlines'),
        item('Show Formulas', 'toggleFormulas', 'CmdOrCtrl+`'),
        sep,
        { label: 'Freeze', submenu: [item('Freeze Up to Current Row', 'freezeRows'), item('Freeze Up to Current Column', 'freezeCols'), item('Freeze Top Row', 'freezeTop'), item('Unfreeze', 'unfreeze')] },
        sep,
        item('Zoom In', 'zoomIn', 'CmdOrCtrl+='),
        item('Zoom Out', 'zoomOut', 'CmdOrCtrl+-'),
        item('Actual Size', 'zoomReset', 'CmdOrCtrl+0'),
        sep,
        { label: 'Theme', submenu: [item('Match System', 'themeSystem'), item('Light', 'themeLight'), item('Dark', 'themeDark')] },
        { role: 'togglefullscreen' },
        ...(o.dev ? [sep, { role: 'toggleDevTools' }, { role: 'reload' }] : [])
      ]
    },
    {
      label: '&Insert',
      submenu: [
        item('Row Above', 'insertRowAbove'), item('Row Below', 'insertRowBelow'),
        item('Column Left', 'insertColLeft'), item('Column Right', 'insertColRight'),
        sep,
        item('Sheet', 'insertSheet', 'Shift+F11'),
        sep,
        item('Function…', 'insertFunction', 'Shift+F3'),
        item('Current Date', 'insertDate', 'CmdOrCtrl+;'),
        item('Current Time', 'insertTime', 'CmdOrCtrl+Shift+;')
      ]
    },
    {
      label: 'F&ormat',
      submenu: [
        item('Bold', 'bold', 'CmdOrCtrl+B'), item('Italic', 'italic', 'CmdOrCtrl+I'), item('Underline', 'underline', 'CmdOrCtrl+U'), item('Strikethrough', 'strike', 'CmdOrCtrl+Shift+X'),
        sep,
        { label: 'Number', submenu: [item('General', 'fmtGeneral'), item('Number (1,234.56)', 'fmtNumber'), item('Percent (12.3%)', 'fmtPercent'), item('Currency ($1,234.56)', 'fmtCurrency'), item('Date (2024-03-05)', 'fmtDate'), item('Time (14:30)', 'fmtTime'), item('Date and Time', 'fmtDateTime'), item('Scientific (1.23E+04)', 'fmtScientific'), item('Text', 'fmtText'), sep, item('More Decimals', 'decimalsUp'), item('Fewer Decimals', 'decimalsDown'), sep, item('Custom…', 'formatCells')] },
        { label: 'Align', submenu: [item('Left', 'alignLeft', 'CmdOrCtrl+Shift+L'), item('Center', 'alignCenter', 'CmdOrCtrl+Shift+C'), item('Right', 'alignRight', 'CmdOrCtrl+Shift+R'), sep, item('Top', 'alignTop'), item('Middle', 'alignMiddle'), item('Bottom', 'alignBottom')] },
        item('Wrap Text', 'wrap'),
        sep,
        item('Format Cells…', 'formatCells', 'CmdOrCtrl+1'),
        item('Clear Formatting', 'clearFormat', 'CmdOrCtrl+\\'),
        sep,
        item('Fit Column Width', 'fitColumns')
      ]
    },
    {
      label: '&Data',
      submenu: [
        item('Sort A → Z', 'sortAsc'), item('Sort Z → A', 'sortDesc'), item('Sort Range…', 'sortDialog'),
        sep,
        item('Filter', 'toggleFilter', 'CmdOrCtrl+Shift+F'),
        item('Clear All Filters', 'clearFilters'),
        sep,
        item('Remove Duplicates…', 'removeDuplicates'),
        item('Trim Whitespace', 'trimWhitespace')
      ]
    },
    {
      label: '&MetaCode',
      submenu: [
        item('AI Assistant', 'aiAssistant', 'CmdOrCtrl+Shift+A'),
        item('AI Coding…', 'aiCoding'),
        item('Intercoder Reliability…', 'reliability'),
        sep,
        item('Open a MetaCode Project…', 'openProject'),
        item('Save Sheet as a MetaCode Project…', 'saveProject'),
        item('Import Scraper Results…', 'scraperImport'),
        sep,
        item('Account and Plan', 'account'),
        item('Upgrade…', 'upgrade')
      ]
    },
    {
      label: '&Help',
      submenu: [
        item('Keyboard Shortcuts', 'shortcuts', 'CmdOrCtrl+/'),
        item('Functions', 'functionsHelp'),
        item('MetaCode Website', 'website'),
        ...(mac ? [] : [sep, item('About MetaCode Sheets', 'about')])
      ]
    }
  ];
}

module.exports = { menuTemplate };
