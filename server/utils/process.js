// server/utils/process.js
async function killProcess(proc, timeoutMs = 800) {
  if (!proc) return;

  await new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const t = setTimeout(finish, timeoutMs);

    proc.once("exit", () => {
      clearTimeout(t);
      finish();
    });

    proc.once("error", () => {
      clearTimeout(t);
      finish();
    });

    try {
      proc.kill("SIGKILL");
    } catch {
      clearTimeout(t);
      finish();
    }
  });
}

module.exports = { killProcess };
