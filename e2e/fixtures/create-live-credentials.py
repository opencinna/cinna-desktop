import httpx, json, uuid
from tests.utils.desktop_auth import obtain_desktop_tokens
client=httpx.Client(base_url='http://127.0.0.1:8000', timeout=30)
accounts=[]
for label in ['owner','recipient']:
 email=f'credentials-e2e-{label}-{uuid.uuid4().hex[:10]}@example.com'
 password=uuid.uuid4().hex+'A!9'
 r=client.post('/api/v1/users/signup',json={'email':email,'password':password});r.raise_for_status()
 user=r.json()
 r=client.post('/api/v1/login/access-token', data={'username':email,'password':password});r.raise_for_status()
 headers={'Authorization':'Bearer '+r.json()['access_token']}
 desktop=obtain_desktop_tokens(client,headers,device_name='Credential delivery live E2E')
 accounts.append({'user_id':user['id'],'email':email,'headers':headers,'desktop':desktop})
owner,recipient=accounts
r=client.post('/api/v1/credentials/',headers=owner['headers'],json={'name':'Live credential delivery fixture','type':'api_token','service_uri':'live-fixture','allow_sharing':True,'allow_local_use':True,'credential_data':{'api_token_type':'bearer','api_token':'live-delivery-fixture-secret-123'}});r.raise_for_status()
c=r.json()
r=client.post(f'/api/v1/credentials/{c["id"]}/shares',headers=owner['headers'],json={'shared_with_email':recipient['email']});r.raise_for_status()
print(json.dumps({'accounts':accounts,'credential_id':c['id'],'share_id':r.json()['id']}))
