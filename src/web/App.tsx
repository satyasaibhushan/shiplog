import { Ship } from "lucide-react";

export function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <div className="flex items-center gap-3">
        <Ship className="w-10 h-10 text-blue-400" />
        <h1 className="text-4xl font-bold tracking-tight">shiplog</h1>
      </div>
      <p className="text-neutral-400 text-lg">
        Visualize what you actually built.
      </p>
      <div className="mt-8 text-sm text-neutral-500">
        Ready to go. Select a date range to get started.
      </div>
    </div>
  );
}
