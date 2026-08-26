import { confirmDialog } from '../store/useConfirmStore';
import { typeToConfirmDialog } from '../store/useTypeToConfirmStore';

/** The exact phrase the third step requires — on explicit request, a step
 * up from the first two plain confirmDialog clicks (easy to click through
 * on autopilot) to something that actually requires reading and typing. */
const DELETE_TABLE_CONFIRMATION_TEXT = 'TAIP_TIKRAI_NORIU_PAŠALINTI';

/** Deleting a whole table has no undo path at all — undo/redo history is
 * per-table and reset on load, so there's nothing to recover through even
 * the usual Ctrl+Z. This is the one action in the app that gets three
 * confirmation steps instead of the single confirmDialog every other
 * delete uses: two plain yes/no clicks, then a required-text-match step
 * (typeToConfirmDialog) that only unlocks its confirm button once the
 * exact phrase above is typed. Shared by WorkspaceView's Delete button and
 * SheetTabs' right-click menu so both paths ask the same way. */
export async function confirmDeleteTable(name: string, rowCount: number): Promise<boolean> {
  const first = await confirmDialog({ message: `Ištrinti lentelę „${name}“ ir visas jos eilutes?`, danger: true });
  if (!first) return false;
  const second = await confirmDialog({
    title: 'Ar tikrai?',
    message: `Tai negrįžtamai ištrins lentelę „${name}“${rowCount > 0 ? ` ir visas jos ${rowCount} eilutes` : ''}. Šio veiksmo anuliuoti negalėsite.`,
    confirmLabel: 'Ištrinti negrįžtamai',
    danger: true,
  });
  if (!second) return false;
  return typeToConfirmDialog({
    title: 'Paskutinis patvirtinimas',
    message: `Norėdami galutinai ištrinti lentelę „${name}“, patvirtinkite žemiau.`,
    requiredText: DELETE_TABLE_CONFIRMATION_TEXT,
    confirmLabel: 'Ištrinti negrįžtamai',
  });
}
