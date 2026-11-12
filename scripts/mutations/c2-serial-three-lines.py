"""把 marker 协议改回三行（整支评审的 C2）。"""
p = 'src/main/hal/serial.ts'
s = open(p, encoding='utf-8').read()
old = "    this.port?.write(`${command}; echo ${marker}\\r\\n`);"
new = "    this.port?.write(`${marker}\\r\\n${command}\\r\\n${marker}\\r\\n`);"
assert old in s, '没找到 write 调用'
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('已变异：marker 三行')
