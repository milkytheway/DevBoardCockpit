"""把文件互传改回跑远端 pull/push 命令（整支评审的 C5）。"""
p = 'src/main/files/transfer.ts'
s = open(p, encoding='utf-8').read()
old = "    await conn.pull(remotePath, localPath);"
new = "    await conn.exec(`pull ${remotePath} ${localPath}`);"
assert old in s
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('已变异：跑远端命令')
