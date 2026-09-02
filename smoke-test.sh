#!/usr/bin/env bash
BASE=http://127.0.0.1:8787
JAR=./test_cookies.txt
rm -f $JAR

hit() { curl -s -w "  [HTTP %{http_code}]\n" "$@"; echo; }

echo "== 1. 未登录访问日志列表（期望 401）=="
hit $BASE/api/logs

echo "== 2. 未登录访问分类接口（期望 401）=="
hit $BASE/api/categories

echo "== 3. 错误密码登录（期望 401）=="
hit -X POST $BASE/api/login -H "Content-Type: application/json" -d '{"password":"wrong-pass"}'

echo "== 4. 正确密码登录（期望 200 + Set-Cookie）=="
hit -c $JAR -X POST $BASE/api/login -H "Content-Type: application/json" -d '{"password":"test-pass-1234"}'

echo "== 5. 携带会话创建日志（期望 201）=="
hit -b $JAR -X POST $BASE/api/logs -H "Content-Type: application/json" \
  -d '{"title":"冒烟测试","content":"第一条日志内容","level":"INFO","category":"ops"}'

echo "== 6. 创建第二条（ERROR 级别）=="
hit -b $JAR -X POST $BASE/api/logs -H "Content-Type: application/json" \
  -d '{"title":"磁盘告警","content":"/dev/sda1 使用率 91%","level":"ERROR","category":"ops"}'

echo "== 7. 列表查询（期望 200，含 2 条）=="
hit -b $JAR "$BASE/api/logs?limit=20"

echo "== 8. 按级别筛选 ERROR=="
hit -b $JAR "$BASE/api/logs?level=ERROR"

echo "== 9. 关键词搜索“磁盘”=="
hit -b $JAR "$BASE/api/logs?keyword=%E7%A3%81%E7%9B%98"

echo "== 10. 编辑第 1 条（期望 200）=="
hit -b $JAR -X PUT $BASE/api/logs/1 -H "Content-Type: application/json" \
  -d '{"title":"冒烟测试（已修改）","content":"修改后的内容","level":"WARN","category":"ops"}'

echo "== 11. 单条详情（期望 200）=="
hit -b $JAR $BASE/api/logs/1

echo "== 12. 校验：内容为空应被拒（期望 400）=="
hit -b $JAR -X POST $BASE/api/logs -H "Content-Type: application/json" \
  -d '{"title":"空内容","content":"   ","level":"INFO"}'

echo "== 13. 校验：非法 level 应被拒（期望 400）=="
hit -b $JAR -X POST $BASE/api/logs -H "Content-Type: application/json" \
  -d '{"title":"x","content":"y","level":"HACK"}'

echo "== 14. 删除第 2 条（期望 200）=="
hit -b $JAR -X DELETE $BASE/api/logs/2

echo "== 15. 删除后再查（期望 404）=="
hit -b $JAR $BASE/api/logs/2

echo "== 16. 退出登录（期望 200）=="
hit -b $JAR -c $JAR -X POST $BASE/api/logout

echo "== 17. 退出后访问列表（期望 401）=="
hit -b $JAR $BASE/api/logs

echo "== 18. 暴力破解：连续错误密码直到锁定 =="
for i in 1 2 3 4 5; do
  printf "第 %s 次：" $i
  curl -s -w "  [HTTP %{http_code}]\n" -X POST $BASE/api/login \
    -H "Content-Type: application/json" -d '{"password":"brute-force"}'
done

echo "== 19. 锁定期内用正确密码登录（期望 429）=="
hit -X POST $BASE/api/login -H "Content-Type: application/json" -d '{"password":"test-pass-1234"}'

rm -f $JAR
