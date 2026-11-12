"""把串口的 port.open() 去掉（整支评审的 C1）。"""
p = 'src/main/hal/serial.ts'
s = open(p, encoding='utf-8').read()
old = "  await port.open();"
new = "  // await port.open();  // 变异"
assert old in s
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('已变异：端口不开')
