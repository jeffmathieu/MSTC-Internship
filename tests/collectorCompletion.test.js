const assert = require('assert');
const { haltCollectorForCompletion } = require('../src/main/collectorCompletion');

{
  const calls = [];
  let polling = true;
  let status = 'collecting';

  const errors = haltCollectorForCompletion({
    clearPolling: () => { polling = false; calls.push('polling stopped'); },
    closeLiveSource: () => calls.push('source closed'),
    markFinished: () => { status = 'finished'; calls.push('state finished'); },
    publishState: () => calls.push('state published')
  });

  assert.deepStrictEqual(errors, []);
  assert.strictEqual(polling, false, 'polling must stop without waiting for an OK dialog');
  assert.strictEqual(status, 'finished', 'the renderer state must be finished immediately');
  assert.deepStrictEqual(calls, [
    'polling stopped',
    'source closed',
    'state finished',
    'state published'
  ]);
}

{
  const calls = [];
  const errors = haltCollectorForCompletion({
    clearPolling: () => calls.push('polling stopped'),
    closeLiveSource: () => { throw new Error('window already closed'); },
    markFinished: () => calls.push('state finished'),
    publishState: () => calls.push('state published')
  });

  assert.strictEqual(errors.length, 1, 'a close error should be reported');
  assert.strictEqual(errors[0].name, 'closeLiveSource');
  assert.deepStrictEqual(
    calls,
    ['polling stopped', 'state finished', 'state published'],
    'a window-close error must not prevent the finished state from being published'
  );
}

{
  const calls = [];
  const errors = haltCollectorForCompletion({
    clearPolling: () => calls.push('polling stopped'),
    closeLiveSource: () => calls.push('source closed'),
    markFinished: null,
    publishState: () => calls.push('state published')
  });

  assert.strictEqual(errors.length, 1, 'invalid lifecycle callbacks should be reported');
  assert.strictEqual(errors[0].name, 'markFinished');
  assert.deepStrictEqual(calls, ['polling stopped', 'source closed', 'state published']);
}
