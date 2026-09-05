self.onmessage = ({ data }) => {
  const timer = new BigInt64Array(data);
  while (true) Atomics.store(timer, 0, BigInt(Math.round(performance.now() * 1000)));
};
