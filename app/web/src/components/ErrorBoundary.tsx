import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

// Stops uncaught render/effect errors from blanking out the whole app.
// Wrap each route in the page tree so a broken page shows a contained
// error card with a retry button, while the rest of the shell stays usable.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return (
      <div className="m-4 rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <div className="mb-2 font-semibold">Something went wrong.</div>
        <div className="mb-3 break-all font-mono text-xs">
          {this.state.error.message}
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
        >
          Try again
        </button>
      </div>
    );
  }
}
