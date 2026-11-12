"""把终端输出改回「累积串重放」（整支评审的 C4）。"""
p = 'src/renderer/terminal/TerminalView.tsx'
s = open(p, encoding='utf-8').read()
old = """  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      termRef.current?.write(chunk);
    });
  }, [subscribe]);"""
new = """  const accRef = useRef('');
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((chunk: string) => {
      accRef.current += chunk;
      termRef.current?.write(accRef.current);
    });
  }, [subscribe]);"""
assert old in s, '没找到 subscribe 的 effect'
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('已变异：累积串重放')
