// JavaScript helpers for Python Workflows

const NON_RETRYABLE_ERROR_NAME = "NonRetryableError";

// Pyodide throws a `PythonError` into JS when a Python exception escapes a
// Python function. Its `message` is the formatted traceback and its `type` is
// the unqualified name of the Python exception class. The class does not set
// `name`, so identify it by its constructor.
function isPythonError(e) {
  return (
    e instanceof Error &&
    e.constructor?.name === "PythonError" &&
    typeof e.type === "string"
  );
}

// Extract the message the user passed to the Python exception from the
// traceback stored in `PythonError.message`. The final line of a formatted
// traceback is `<qualified.ExceptionType>: <message>`, or just the type when
// the exception has no message.
function pythonExceptionMessage(e) {
  const lines = e.message.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1) ?? "";
  const sep = last.indexOf(": ");
  return sep === -1 ? "" : last.slice(sep + 2);
}

// Wraps a Python step callback passed to `WorkflowStep.do()`.
//
// The Workflows engine invokes the callback over RPC and decides whether to
// retry a failed step by inspecting the JS error's `name`. A Python exception
// reaches JS as a Pyodide `PythonError` whose message is the traceback;
// tunneled over RPC it becomes a plain `Error`, so a Python `NonRetryableError`
// would be retried. Raising a JS error from Python does not help either:
// Pyodide re-wraps a `JsException` escaping a coroutine in a `PythonError`.
//
// So translate the error here. Only `NonRetryableError` is translated; other
// Python exceptions are left untouched.
export function wrapWorkflowStepCallback(pyCallback) {
  return async function (...args) {
    try {
      return await pyCallback(...args);
    } catch (e) {
      if (isPythonError(e) && e.type === NON_RETRYABLE_ERROR_NAME) {
        const err = new Error(pythonExceptionMessage(e));
        err.name = NON_RETRYABLE_ERROR_NAME;
        throw err;
      }
      throw e;
    }
  };
}

// Wraps the `WorkflowStep` RPC stub passed to a Python
// `WorkflowEntrypoint.run()` so that the callback given to `step.do()` goes
// through `wrapWorkflowStepCallback`.
//
// Because the wrapped `do` returns the stub's own promise, a Python callback
// passed to it keeps exactly the lifetime it would have had without the
// wrapper.
export function wrapWorkflowStep(step) {
  // RPC stubs are callable, so `typeof step` is 'function'.
  if (
    step === null ||
    (typeof step !== "object" && typeof step !== "function")
  ) {
    return step;
  }
  return new Proxy(step, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      if (prop !== "do") {
        return Reflect.get(target, prop);
      }
      return function (name, ...rest) {
        const args = rest.map((arg) =>
          typeof arg === "function" ? wrapWorkflowStepCallback(arg) : arg
        );
        return target.do(name, ...args);
      };
    },
  });
}
