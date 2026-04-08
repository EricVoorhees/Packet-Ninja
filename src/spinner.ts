import readline from "node:readline";
import process from "node:process";
import cliSpinners from "cli-spinners";

interface SpinnerHandle {
  stopSuccess: (message?: string) => void;
  stopFailure: (message?: string) => void;
}

interface SpinnerTaskOptions {
  fallbackLine?: (message: string) => void;
  successMessage?: string;
  failureMessage?: string;
}

function spinnerEnabled(): boolean {
  if (process.env.PACKAGE_NINJA_NO_SPINNER === "1") {
    return false;
  }

  if (process.env.CI) {
    return false;
  }

  return Boolean(process.stdout.isTTY);
}

function startSpinner(message: string): SpinnerHandle | null {
  if (!spinnerEnabled()) {
    return null;
  }

  const spinner = cliSpinners.dots;
  let frameIndex = 0;
  let stopped = false;

  const render = (): void => {
    const frame = spinner.frames[frameIndex % spinner.frames.length];
    frameIndex += 1;
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${frame} ${message}`);
    readline.clearLine(process.stdout, 1);
  };

  render();
  const timer = setInterval(render, spinner.interval);
  timer.unref();

  const finish = (symbol: string, finalMessage?: string): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${symbol} ${finalMessage ?? message}\n`);
  };

  return {
    stopSuccess: (finalMessage?: string) => {
      finish("✔", finalMessage);
    },
    stopFailure: (finalMessage?: string) => {
      finish("✖", finalMessage);
    }
  };
}

export async function runSpinnerTask<T>(
  message: string,
  task: () => Promise<T>,
  options: SpinnerTaskOptions = {}
): Promise<T> {
  const spinner = startSpinner(message);
  if (!spinner) {
    options.fallbackLine?.(message);
  }

  try {
    const result = await task();
    spinner?.stopSuccess(options.successMessage);
    return result;
  } catch (error) {
    spinner?.stopFailure(options.failureMessage);
    throw error;
  }
}

