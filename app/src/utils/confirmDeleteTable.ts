import { confirmDialog } from '../store/useConfirmStore';

/** Deleting a whole table has no undo path at all — undo/redo history is
 * per-table and reset on load, so there's nothing to recover through even
 * the usual Ctrl+Z. This is the one action in the app that gets an extra
 * confirmation step beyond the single confirmDialog every other delete
 * uses. Shared by WorkspaceView's Delete button and SheetTabs' right-click
 * menu so both paths ask the same way. */
export async function confirmDeleteTable(name: string, rowCount: number): Promise<boolean> {
  const first = await confirmDialog({ message: `Ištrinti lentelę „${name}“ ir visas jos eilutes?`, danger: true });
  if (!first) return false;
  return confirmDialog({
    title: 'Ar tikrai?',
    message: `Tai negrįžtamai ištrins lentelę „${name}“${rowCount > 0 ? ` ir visas jos ${rowCount} eilutes` : ''}. Šio veiksmo anuliuoti negalėsite.`,
    confirmLabel: 'Ištrinti negrįžtamai',
    danger: true,
  });
}
