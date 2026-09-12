import { useToastStore } from '../store/useToastStore';

export function DemoToast() {
  const message = useToastStore((s) => s.message);
  const clear = useToastStore((s) => s.clear);

  if (!message) return null;

  return (
    <div className="toast" role="status" onClick={clear}>
      {message}
    </div>
  );
}
