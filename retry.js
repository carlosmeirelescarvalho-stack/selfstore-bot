async function comRetry(fn, { tentativas = 3, baseMs = 1000, label = '' } = {}) {
  let ultimo
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn()
    } catch (err) {
      ultimo = err
      if (i < tentativas - 1) {
        const delay = baseMs * Math.pow(2, i)
        console.warn(`[retry] ${label} tentativa ${i + 1}/${tentativas} falhou (${err.message}), próxima em ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw ultimo
}

module.exports = { comRetry }
