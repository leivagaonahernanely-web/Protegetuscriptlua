"""Shared loader builders for the Discord bot."""

def build_public_loader(domain: str, hash_id: str, key: str = "TU_KEY") -> str:
    domain = domain.rstrip('/')
    return f'''script_key = "{key}"\n\nloadstring(game:HttpGet("{domain}/scripts/hosted/{hash_id}.lua"))()'''
