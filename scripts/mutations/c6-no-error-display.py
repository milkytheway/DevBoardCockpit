"""把 renderer 的错误呈现去掉（整支评审的 C6）。

用户点了串口、串口被占用——错误藏在控制台里等于没报。
"""
p = 'src/renderer/App.tsx'
s = open(p, encoding='utf-8').read()
old = """      {error ? (
        <p className="cockpit-error" role="alert">
          {error}
        </p>
      ) : null}"""
new = """      {null}"""
assert old in s, '没找到错误呈现'
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('已变异：不呈现错误')
